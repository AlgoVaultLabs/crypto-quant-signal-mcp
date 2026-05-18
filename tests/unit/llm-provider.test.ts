/**
 * AV-CHAT-MCP-W1 (C4) — vitest canary for src/lib/llm-provider.ts.
 *
 * Locks LLMProvider invariants:
 *   - StubLLMProvider returns `[STUB] <last-user>` text and zero usage.
 *   - getLLMProvider() returns Stub when ANTHROPIC_API_KEY is unset/empty.
 *   - getLLMProvider() returns AnthropicProvider when ANTHROPIC_API_KEY set.
 *   - AnthropicProvider constructor throws on missing/empty key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  StubLLMProvider,
  AnthropicProvider,
  getLLMProvider,
  LLMProviderError,
} from '../../src/lib/llm-provider.js';

describe('StubLLMProvider', () => {
  it('returns [STUB] prefixed text echoing the last user message', async () => {
    const stub = new StubLLMProvider();
    const out = await stub.complete(
      [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'How do I get a BTC trade signal?' },
      ],
      { model: 'claude-haiku-4-5-20251001', maxTokens: 100, temperature: 0.3, systemPrompt: 'sys' },
    );
    expect(out.text).toContain('[STUB]');
    expect(out.text).toContain('How do I get a BTC trade signal?');
    expect(out.usage.promptTokens).toBe(0);
    expect(out.usage.completionTokens).toBe(0);
  });
});

describe('getLLMProvider() factory', () => {
  const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
    }
  });

  it('returns StubLLMProvider when ANTHROPIC_API_KEY is unset', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const provider = getLLMProvider();
    expect(provider.name).toBe('stub');
    expect(provider).toBeInstanceOf(StubLLMProvider);
  });

  it('returns StubLLMProvider when ANTHROPIC_API_KEY is empty string', () => {
    process.env.ANTHROPIC_API_KEY = '';
    const provider = getLLMProvider();
    expect(provider.name).toBe('stub');
  });

  it('returns AnthropicProvider when ANTHROPIC_API_KEY is set (no live call)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-test-key';
    const provider = getLLMProvider();
    expect(provider.name).toBe('anthropic');
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });
});

describe('AnthropicProvider constructor', () => {
  it('throws LLMProviderError on empty key', () => {
    expect(() => new AnthropicProvider('')).toThrow(LLMProviderError);
  });
});
