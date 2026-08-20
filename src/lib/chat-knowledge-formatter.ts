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
import type { AuthState, LicenseInfo } from '../types.js';
import { withAuthState } from './tier-warning.js';

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
    /**
     * AUTH-THREE-STATE-W1 CH2 (additive). This envelope is NOT `AlgoVaultMeta` — it is its own
     * shape with its own snapshot — so the member is declared here too rather than inherited.
     * Coverage is 7/7 live tools, and that includes this one.
     */
    auth?: AuthState;
  };
}

export function formatChatKnowledgeResponse(
  result: ChatResult,
  bundle: KnowledgeBundle | null,
  quotaRemaining: number | null,
  // OPTIONAL, deliberately, and symmetric with the search formatter. A REQUIRED parameter on a
  // shared formatter breaks every caller the wave did not update — and `tsc` does not catch it,
  // because tests are outside the typecheck: making it required turned
  // `tests/integration/knowledge-flow.test.ts` into a runtime TypeError on the very first suite
  // run. Optional means a caller that has no license emits the pre-wave envelope, byte-identical,
  // instead of crashing. Both production call sites DO pass one.
  license?: Pick<LicenseInfo, 'key' | 'tier' | 'outcome'>,
): ChatKnowledgeResponse {
  const meta = {
    bundle_version: bundle?.version ?? 'unknown',
    bundle_generated_at: bundle?.generated_at ?? '',
    quota_remaining: quotaRemaining,
  };
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
    // The formatter runs PER REQUEST — the chat cache stores the ChatResult, not this envelope —
    // so a per-caller member is safe here, exactly as `quota_remaining` already is. The HTTP twin
    // (`POST /api/chat`) is `Cache-Control: no-store`, so no shared cache can cross callers.
    _algovault: license ? withAuthState(meta, license) : meta,
  };
}
