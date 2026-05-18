/**
 * chat_knowledge response formatter — AV-CHAT-MCP-W1 (C3).
 *
 * Pure allow-list formatter. `usage.{promptTokens,completionTokens}` are
 * OPERATOR-INTERNAL — never leak via the public response shape. Cost
 * forensics live in the `chat_usage_monthly` Postgres table; the response
 * to end-users carries only the model id + quota remaining.
 *
 * Locked by `audits/chat-knowledge-shape-snapshot-2026-05-18.json`.
 */
import type { ChatResult } from './chat-engine.js';
import type { KnowledgeBundle } from './knowledge-formatter.js';

export interface ChatKnowledgeResponse {
  question: string;
  answer: string;
  citations: Array<{
    source_type: string;
    source_url: string;
    title: string;
    excerpt: string;
  }>;
  model: string;
  _algovault: {
    bundle_version: string;
    bundle_generated_at: string;
    quota_remaining: number | null;
  };
}

export function formatChatKnowledgeResponse(
  result: ChatResult,
  bundle: KnowledgeBundle | null,
  quotaRemaining: number | null,
): ChatKnowledgeResponse {
  return {
    question: result.question,
    answer: result.answer,
    citations: result.citations.map((c) => ({
      source_type: c.source_type,
      source_url: c.source_url,
      title: c.title,
      excerpt: c.excerpt,
    })),
    model: result.model,
    _algovault: {
      bundle_version: bundle?.version ?? 'unknown',
      bundle_generated_at: bundle?.generated_at ?? '',
      quota_remaining: quotaRemaining,
    },
  };
}
