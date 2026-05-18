/**
 * LLM provider abstraction — AV-CHAT-MCP-W1 (C3).
 *
 * Wraps `@anthropic-ai/sdk@^0.96`. Surface designed so future providers
 * (`OpenAIProvider`, `GeminiProvider`) can implement the same interface
 * without ChatEngine churn.
 *
 * The locked verbatim system prompt is identical across every chat call so
 * Anthropic prompt caching is a no-brainer: pass `systemPromptCacheable=true`
 * and the SDK emits a `cache_control: { type: 'ephemeral' }` breakpoint on
 * the system block. With Haiku 4.5 the savings are ~$0.65/mo at expected
 * utilization; with Sonnet 4.6 they're ~$5+/mo.
 *
 * If `ANTHROPIC_API_KEY` is unset, the factory returns `StubLLMProvider`
 * (canned response with the question echoed back). Server still boots; chat
 * tool returns a recognizable `[STUB] ...` payload with citations intact.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMCompletionOpts {
  model: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
  systemPromptCacheable?: boolean;
}

export interface LLMCompletion {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens?: number;
  };
}

// Provider name union — extended for forward-compat per CHAT-USAGE-ANALYTICS-W1
// Q-4 Path B (Cowork-ratified). LLM-PROVIDER-A/B-W1 will add concrete classes
// for 'openai' / 'gemini'; the union widens here so analytics + dashboards
// can reference all 4 from day one with zero migration coordination.
export type LLMProviderName = 'anthropic' | 'stub' | 'openai' | 'gemini';

export interface LLMProvider {
  readonly name: LLMProviderName;
  complete(messages: LLMMessage[], opts: LLMCompletionOpts): Promise<LLMCompletion>;
}

export class LLMProviderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'LLMProviderError';
  }
}

const RETRY_DELAYS_MS = [500, 1500]; // 2 retries with exponential backoff

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new LLMProviderError(
        'MISSING_ANTHROPIC_API_KEY',
        'AnthropicProvider requires a non-empty apiKey',
      );
    }
    this.client = new Anthropic({ apiKey });
  }

  async complete(messages: LLMMessage[], opts: LLMCompletionOpts): Promise<LLMCompletion> {
    const system = opts.systemPromptCacheable
      ? [{ type: 'text' as const, text: opts.systemPrompt, cache_control: { type: 'ephemeral' as const } }]
      : opts.systemPrompt;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: opts.model,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
          system,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        });
        const textBlock = response.content.find((b) => b.type === 'text');
        const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
        return {
          text,
          usage: {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            cachedPromptTokens: response.usage.cache_read_input_tokens ?? undefined,
          },
        };
      } catch (err: unknown) {
        lastErr = err;
        // Retry on 429 (rate limit), 500, 503; otherwise propagate
        const status = (err as { status?: number })?.status;
        const isRetryable = status === 429 || status === 500 || status === 503;
        if (!isRetryable || attempt >= RETRY_DELAYS_MS.length) {
          break;
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new LLMProviderError('ANTHROPIC_API_ERROR', `Anthropic API call failed: ${message}`);
  }
}

export class StubLLMProvider implements LLMProvider {
  readonly name = 'stub' as const;

  async complete(messages: LLMMessage[], _opts: LLMCompletionOpts): Promise<LLMCompletion> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const echo = lastUser ? lastUser.content.slice(0, 100) : '';
    return {
      text: `[STUB] ${echo}`,
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }
}

let _stubWarnLogged = false;

/**
 * Factory — returns `AnthropicProvider` if `ANTHROPIC_API_KEY` is present,
 * otherwise `StubLLMProvider` with a console.warn (once) at startup.
 */
export function getLLMProvider(): LLMProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.trim().length > 0) {
    return new AnthropicProvider(apiKey);
  }
  if (!_stubWarnLogged) {
    _stubWarnLogged = true;
    console.warn(
      '[llm-provider] ANTHROPIC_API_KEY not set — chat_knowledge will return [STUB] responses. ' +
        'See audits/AV-CHAT-MCP-W1-endpoint-truth.md Q-3 for provisioning steps.',
    );
  }
  return new StubLLMProvider();
}
