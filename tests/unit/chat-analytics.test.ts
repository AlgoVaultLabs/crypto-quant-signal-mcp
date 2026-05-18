/**
 * CHAT-USAGE-ANALYTICS-W1 (R8) — vitest canary.
 *
 * Locks the PII guard + pricing math + middleware error-handling invariants.
 * Mocks `dbRun` / `dbExec` from performance-db.ts so tests run without a
 * Postgres backend. The actual SQL is the responsibility of the live
 * post-deploy probe (which runs against real PG inside the container).
 *
 * Six cases per spec L193-198 + 1 Cowork Q-4 Path B addition:
 *   1. recordChatEvent stores hash not raw question
 *   2. costUsdE6 computes Anthropic Haiku correctly
 *   3. costUsdE6 handles cached input discount
 *   4. costUsdE6 returns 0 on unknown model with warn log (default-deny)
 *   5. recordChatEvent silently recovers on DB failure
 *   6. provider column propagates through INSERT params
 *   (+ extras: no-answer flag triggers on canonical phrase; bounds-checking)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock performance-db BEFORE importing the unit under test.
vi.mock('../../src/lib/performance-db.js', () => ({
  dbExec: vi.fn(),
  dbRun: vi.fn(),
  dbQuery: vi.fn(),
}));

import { dbRun } from '../../src/lib/performance-db.js';
import { recordChatEvent, NO_ANSWER_PHRASE } from '../../src/lib/chat-analytics.js';
import { costUsdE6, _resetUnknownModelWarnCacheForTests } from '../../src/lib/llm-pricing.js';

describe('costUsdE6 — LLM pricing primitive', () => {
  beforeEach(() => {
    _resetUnknownModelWarnCacheForTests();
  });

  it('computes Anthropic Haiku 4.5 correctly (no cache)', () => {
    // Haiku 4.5: $1/M input · $5/M output
    // 100k input + 50k output = 100k * $1/M + 50k * $5/M
    //                         = $0.10 + $0.25 = $0.35 = 350_000 micro-USD
    const cost = costUsdE6('claude-haiku-4-5-20251001', { promptTokens: 100_000, completionTokens: 50_000 });
    expect(cost).toBe(350_000);
  });

  it('handles cached input discount (90% off cached portion)', () => {
    // 100k input total · 80k cached + 20k uncached · 50k output
    // = 20k * $1/M + 80k * $0.10/M + 50k * $5/M
    // = $0.020 + $0.008 + $0.250 = $0.278 = 278_000 micro-USD
    const cost = costUsdE6('claude-haiku-4-5-20251001', {
      promptTokens: 100_000,
      completionTokens: 50_000,
      cachedPromptTokens: 80_000,
    });
    expect(cost).toBe(278_000);
  });

  it('computes Sonnet 4.6 at 3x Haiku price', () => {
    // Sonnet: $3/M input · $15/M output
    // 100k in + 50k out = $0.30 + $0.75 = $1.05 = 1_050_000 micro-USD
    const cost = costUsdE6('claude-sonnet-4-6', { promptTokens: 100_000, completionTokens: 50_000 });
    expect(cost).toBe(1_050_000);
  });

  it('returns 0 on unknown model + warns once (default-deny per CLAUDE.md)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cost1 = costUsdE6('claude-future-9000', { promptTokens: 100_000, completionTokens: 50_000 });
    const cost2 = costUsdE6('claude-future-9000', { promptTokens: 50_000, completionTokens: 25_000 });
    expect(cost1).toBe(0);
    expect(cost2).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1); // warn-once-per-process-per-model
    expect(warnSpy.mock.calls[0]?.[0]).toContain('unknown model');
    warnSpy.mockRestore();
  });

  it('handles zero / negative token counts as 0 (no throw)', () => {
    expect(costUsdE6('claude-haiku-4-5-20251001', { promptTokens: 0, completionTokens: 0 })).toBe(0);
    expect(
      costUsdE6('claude-haiku-4-5-20251001', { promptTokens: -100, completionTokens: -100 }),
    ).toBe(0);
  });
});

describe('recordChatEvent — PII guard + provider round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PII GUARD: stores SHA256-truncated hash, never raw question text', () => {
    const rawQuestion = 'what is my private trading strategy and stop loss for BTC?';
    recordChatEvent({
      apiKeyId: 'av_starter_test',
      apiKeyTier: 'starter',
      surface: 'mcp_tool',
      question: rawQuestion,
      answer: 'BTC trading strategies vary by [source: ...]',
      citationsCount: 3,
      model: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      usage: { promptTokens: 500, completionTokens: 200, cachedPromptTokens: 300 },
      latencyMs: 1234,
    });

    expect(dbRun).toHaveBeenCalledTimes(1);
    const call = vi.mocked(dbRun).mock.calls[0];
    expect(call).toBeDefined();
    const sql = call![0] as string;
    const params = call!.slice(1) as unknown[];

    // PII: raw question text NEVER appears in SQL or params
    expect(sql).not.toContain(rawQuestion);
    expect(sql.toLowerCase()).not.toMatch(/insert.*question[^_]/); // never INSERT raw `question` column
    for (const p of params) {
      expect(String(p)).not.toContain(rawQuestion);
    }
    // Hash IS present (16 hex chars after SHA256 truncation)
    const hashParam = params[3]; // question_hash is the 4th param
    expect(typeof hashParam).toBe('string');
    expect(hashParam).toMatch(/^[0-9a-f]{16}$/);
    // Length IS present
    expect(params[4]).toBe(rawQuestion.length);
  });

  it('provider column propagates through INSERT params (Cowork Q-4 Path B)', () => {
    recordChatEvent({
      apiKeyId: null,
      apiKeyTier: 'free',
      surface: 'http_endpoint',
      question: 'test question',
      answer: 'test answer',
      citationsCount: 0,
      model: 'claude-haiku-4-5-20251001',
      provider: 'stub',
      usage: { promptTokens: 0, completionTokens: 0 },
      latencyMs: 5,
    });
    const params = vi.mocked(dbRun).mock.calls[0]!.slice(1) as unknown[];
    // provider is the 10th positional param (after api_key_id, tier, surface, hash,
    // q_len, ans_len, citations, no_ans_flag, model)
    expect(params[9]).toBe('stub');
  });

  it('no_answer_flag flips on canonical phrase (locked verbatim)', () => {
    recordChatEvent({
      apiKeyId: 'k',
      apiKeyTier: 'free',
      surface: 'mcp_tool',
      question: 'q',
      answer: `${NO_ANSWER_PHRASE}. Try search_knowledge with different keywords.`,
      citationsCount: 0,
      model: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      usage: { promptTokens: 100, completionTokens: 20 },
      latencyMs: 800,
    });
    const params = vi.mocked(dbRun).mock.calls[0]!.slice(1) as unknown[];
    expect(params[7]).toBe(true); // no_answer_flag is the 8th positional param
  });

  it('no_answer_flag stays false on normal answer', () => {
    recordChatEvent({
      apiKeyId: 'k',
      apiKeyTier: 'free',
      surface: 'mcp_tool',
      question: 'q',
      answer: 'Here is your answer. [source: https://api.algovault.com/mcp]',
      citationsCount: 1,
      model: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      usage: { promptTokens: 100, completionTokens: 50 },
      latencyMs: 800,
    });
    const params = vi.mocked(dbRun).mock.calls[0]!.slice(1) as unknown[];
    expect(params[7]).toBe(false);
  });

  it('cost_usd_e6 computed correctly and stored as positional param', () => {
    recordChatEvent({
      apiKeyId: 'k',
      apiKeyTier: 'pro',
      surface: 'http_endpoint',
      question: 'q',
      answer: 'a',
      citationsCount: 0,
      model: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      usage: { promptTokens: 100_000, completionTokens: 50_000 }, // 350_000 µUSD per earlier test
      latencyMs: 500,
    });
    const params = vi.mocked(dbRun).mock.calls[0]!.slice(1) as unknown[];
    // cost_usd_e6 is positional param 14 (after api_key, tier, surface, hash,
    // q_len, ans_len, citations, no_ans, model, provider, prompt_t, comp_t, cached_t)
    expect(params[13]).toBe(350_000);
  });

  it('silently recovers when dbRun throws synchronously (analytics must never break chat)', () => {
    // dbRun in performance-db.ts is fire-and-forget (returns void, catches errors
    // internally). But if param-prep throws (e.g., crypto unavailable), the outer
    // try/catch in recordChatEvent must swallow.
    vi.mocked(dbRun).mockImplementationOnce(() => {
      throw new Error('synthetic db drop');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      recordChatEvent({
        apiKeyId: 'k',
        apiKeyTier: 'free',
        surface: 'mcp_tool',
        question: 'q',
        answer: 'a',
        citationsCount: 0,
        model: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        usage: { promptTokens: 100, completionTokens: 50 },
        latencyMs: 500,
      }),
    ).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0]?.[0]).toContain('chat-analytics');
    errSpy.mockRestore();
  });
});
