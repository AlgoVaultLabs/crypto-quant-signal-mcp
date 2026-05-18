/**
 * Chat analytics middleware — CHAT-USAGE-ANALYTICS-W1 (R1 schema + R3 middleware).
 *
 * Single recording point for every chat call. Both the `chat_knowledge` MCP
 * tool handler and the `/api/chat` Express route funnel through
 * `recordChatEvent()` — one function, one fire-and-forget Postgres insert.
 * Any new chat surface added later (e.g., a future `/api/chat-stream`) just
 * imports and calls this; analytics auto-flow.
 *
 * **PII GUARD (CRITICAL):** never store the raw `question` column. Only a
 * SHA256-truncated `question_hash` + `question_length`. The hash is
 * collision-resistant at AlgoVault scale + intentionally clusters
 * semantically-equivalent rephrasings into the same bucket (desirable for
 * top-N-asked analytics).
 *
 * **Provider column (Path B per Cowork ratification):** every event records
 * `provider` from `llmProvider.name` so future LLM-PROVIDER-A/B-W1 can
 * `WHERE provider = '<name>'` from day one with zero schema migration. Also
 * surfaces `stub` rows on the dashboard / digest as an immediate
 * "ANTHROPIC_API_KEY rotation gap" alert (instead of silently showing
 * $0 cost weeks).
 *
 * Signature deviates from spec's `(pool, ev)` shape to match repo helper-
 * based convention (Q-1 Path A): uses `dbRun` from performance-db.ts.
 * Mirrors AV-CHAT-MCP-W1's `ChatRateLimit.record()` shape. Never throws to
 * caller — analytics failure MUST NEVER break a chat call.
 */
import crypto from 'node:crypto';
import { dbExec, dbRun } from './performance-db.js';
import { costUsdE6 } from './llm-pricing.js';
import type { LLMProviderName } from './llm-provider.js';

/** Canonical no-answer phrase from AV-CHAT-MCP-W1 chat-engine Rule #2. */
export const NO_ANSWER_PHRASE = "I don't have that in my knowledge base";

export type ChatSurface = 'mcp_tool' | 'http_endpoint';
export type ChatTier = 'free' | 'starter' | 'pro' | 'enterprise';

export interface ChatAnalyticsEvent {
  apiKeyId: string | null;
  apiKeyTier: ChatTier;
  surface: ChatSurface;
  /** Raw user question — HASHED before storage; never persisted in raw form. */
  question: string;
  /** LLM answer body — only length + no-answer-phrase membership extracted. */
  answer: string;
  citationsCount: number;
  model: string;
  /** Provider name from `LLMProvider.name` — Cowork Q-4 Path B widening. */
  provider: LLMProviderName;
  usage: {
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens?: number;
  };
  latencyMs: number;
  /** NULL on success; error code string on failure (e.g., 'CHAT_QUOTA_EXHAUSTED'). */
  errorCode?: string | null;
}

const QUESTION_HASH_BYTES = 16; // SHA256 truncated to 16 hex chars = 64 bits

function hashQuestion(question: string): string {
  return crypto.createHash('sha256').update(question).digest('hex').slice(0, QUESTION_HASH_BYTES);
}

/**
 * Idempotent DDL — called once at server boot (per repo convention; mirror
 * of `ensureChatUsageTable()` in chat-rate-limit.ts). Uses `dbExec` fire-and-
 * forget. Includes:
 *   - chat_analytics_events table (15 columns)
 *   - 4 indexes (recorded_at, key+recorded, hash, provider+recorded)
 *   - chat_analytics_daily view (90-day rolling aggregate by day × tier × provider)
 */
export function ensureChatAnalyticsSchema(): void {
  dbExec(`
    CREATE TABLE IF NOT EXISTS chat_analytics_events (
      id           BIGSERIAL PRIMARY KEY,
      recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      api_key_id   TEXT,
      api_key_tier TEXT NOT NULL DEFAULT 'free',
      surface      TEXT NOT NULL,
      question_hash      TEXT NOT NULL,
      question_length    INT NOT NULL,
      answer_length      INT NOT NULL,
      citations_count    INT NOT NULL DEFAULT 0,
      no_answer_flag     BOOLEAN NOT NULL DEFAULT FALSE,
      model              TEXT NOT NULL,
      provider           TEXT NOT NULL DEFAULT 'anthropic',
      prompt_tokens      INT NOT NULL DEFAULT 0,
      completion_tokens  INT NOT NULL DEFAULT 0,
      cached_prompt_tokens INT NOT NULL DEFAULT 0,
      cost_usd_e6        BIGINT NOT NULL DEFAULT 0,
      latency_ms         INT NOT NULL DEFAULT 0,
      error_code         TEXT
    )
  `);
  dbExec(`CREATE INDEX IF NOT EXISTS idx_chat_analytics_events_recorded_at ON chat_analytics_events (recorded_at)`);
  dbExec(`CREATE INDEX IF NOT EXISTS idx_chat_analytics_events_key_recorded ON chat_analytics_events (api_key_id, recorded_at)`);
  dbExec(`CREATE INDEX IF NOT EXISTS idx_chat_analytics_events_hash ON chat_analytics_events (question_hash)`);
  dbExec(`CREATE INDEX IF NOT EXISTS idx_chat_analytics_events_provider ON chat_analytics_events (provider, recorded_at)`);
  dbExec(`
    CREATE OR REPLACE VIEW chat_analytics_daily AS
    SELECT
      date_trunc('day', recorded_at AT TIME ZONE 'UTC') AS day_utc,
      api_key_tier,
      provider,
      count(*) AS queries,
      count(*) FILTER (WHERE no_answer_flag) AS no_answer_queries,
      count(*) FILTER (WHERE error_code IS NOT NULL) AS error_queries,
      sum(prompt_tokens)::BIGINT AS total_prompt_tokens,
      sum(completion_tokens)::BIGINT AS total_completion_tokens,
      sum(cached_prompt_tokens)::BIGINT AS total_cached_prompt_tokens,
      sum(cost_usd_e6)::BIGINT AS total_cost_usd_e6,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50_latency_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms
    FROM chat_analytics_events
    WHERE recorded_at > now() - interval '90 days'
    GROUP BY day_utc, api_key_tier, provider
  `);
}

/**
 * Record a single chat call. Fire-and-forget — never throws to caller.
 * On Postgres failure, logs the error and continues (per CLAUDE.md
 * "default-deny on NaN" + "every load-bearing side-effect needs a companion
 * success-path log" — success log is implicit via the chat surface's
 * existing `logRequest()` call).
 */
export function recordChatEvent(ev: ChatAnalyticsEvent): void {
  try {
    const questionHash = hashQuestion(ev.question);
    const noAnswerFlag = ev.answer.includes(NO_ANSWER_PHRASE);
    const cost = costUsdE6(ev.model, ev.usage);

    // 16 placeholders. INSERT uses positional params via dbRun's `?` → `$N` translator.
    dbRun(
      `INSERT INTO chat_analytics_events
         (api_key_id, api_key_tier, surface, question_hash, question_length,
          answer_length, citations_count, no_answer_flag, model, provider,
          prompt_tokens, completion_tokens, cached_prompt_tokens, cost_usd_e6,
          latency_ms, error_code)
       VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?)`,
      ev.apiKeyId,
      ev.apiKeyTier,
      ev.surface,
      questionHash,
      ev.question.length,
      ev.answer.length,
      ev.citationsCount,
      noAnswerFlag,
      ev.model,
      ev.provider,
      ev.usage.promptTokens,
      ev.usage.completionTokens,
      ev.usage.cachedPromptTokens ?? 0,
      cost,
      ev.latencyMs,
      ev.errorCode ?? null,
    );
  } catch (err) {
    // dbRun is fire-and-forget itself; any sync throw here is from hashing /
    // costUsdE6 / param-prep. Log + swallow. Analytics MUST NOT break chat.
    console.error(
      `[chat-analytics] recordChatEvent silently recovered from sync error: ${err instanceof Error ? err.message : err}`,
    );
  }
}
