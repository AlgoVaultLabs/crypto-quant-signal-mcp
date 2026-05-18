/**
 * LLM pricing primitive — CHAT-USAGE-ANALYTICS-W1 (R2).
 *
 * Fix-at-generator: ONE table of model→price. When LLM-PROVIDER-A/B-W1 adds
 * Gemini / OpenAI, one entry per model lands here and analytics auto-correctly
 * costs them. Consumed by `recordChatEvent()` in chat-analytics.ts.
 *
 * Returns cost in MICRO-DOLLARS (10^-6 USD) as a BIGINT-safe integer — never
 * float. Postgres `cost_usd_e6` column stores this verbatim; dashboard /
 * digest divide by 1e6 only at display time.
 *
 * Pricing reference (2026-05-18):
 *   - Claude Haiku 4.5: $1.00 / $0.10 cached / $5.00 per 1M tokens
 *   - Claude Sonnet 4.6: $3.00 / $0.30 cached / $15.00 per 1M tokens
 *   See https://platform.claude.com/docs/en/about-claude/pricing
 */

export interface ModelPricing {
  /** Standard input price per 1M tokens, USD. */
  inputPerM_usd: number;
  /** Cached input price per 1M tokens, USD (Anthropic ~90% off the standard input rate). */
  cachedInputPerM_usd: number;
  /** Output price per 1M tokens, USD. */
  outputPerM_usd: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5-20251001': {
    inputPerM_usd: 1.0,
    cachedInputPerM_usd: 0.1,
    outputPerM_usd: 5.0,
  },
  'claude-sonnet-4-6': {
    inputPerM_usd: 3.0,
    cachedInputPerM_usd: 0.3,
    outputPerM_usd: 15.0,
  },
  // LLM-PROVIDER-A/B-W1 future entries:
  // 'gpt-5-nano':           { inputPerM_usd: X, cachedInputPerM_usd: X, outputPerM_usd: X },
  // 'gemini-2.5-flash':     { inputPerM_usd: X, cachedInputPerM_usd: X, outputPerM_usd: X },
};

let _unknownModelWarnedOnce = new Set<string>();

/**
 * Compute LLM call cost in MICRO-DOLLARS (10^-6 USD) as an integer.
 *
 * For an unknown model id, logs a console.warn once-per-process-per-model and
 * returns 0 (default-deny on NaN per CLAUDE.md "Default-deny + load-bearing
 * logging" rule). Caller stores the 0 cost; an operator querying for
 * `cost_usd_e6 = 0 AND prompt_tokens > 0` can find unknown-model rows.
 */
export function costUsdE6(
  model: string,
  usage: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number },
): number {
  const p = MODEL_PRICING[model];
  if (!p) {
    if (!_unknownModelWarnedOnce.has(model)) {
      _unknownModelWarnedOnce.add(model);
      console.warn(`[llm-pricing] unknown model ${JSON.stringify(model)} — cost reported as 0`);
    }
    return 0;
  }
  const promptTokens = Math.max(0, usage.promptTokens | 0);
  const completionTokens = Math.max(0, usage.completionTokens | 0);
  const cached = Math.max(0, (usage.cachedPromptTokens ?? 0) | 0);
  const uncachedInput = Math.max(0, promptTokens - cached);

  const dollars =
    (uncachedInput / 1_000_000) * p.inputPerM_usd +
    (cached / 1_000_000) * p.cachedInputPerM_usd +
    (completionTokens / 1_000_000) * p.outputPerM_usd;

  // Round to nearest micro-dollar to avoid floating-point drift in aggregation
  return Math.round(dollars * 1_000_000);
}

/** Test-seam: reset the "unknown model warned once" memo. */
export function _resetUnknownModelWarnCacheForTests(): void {
  _unknownModelWarnedOnce = new Set<string>();
}
