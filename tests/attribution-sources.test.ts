/**
 * ATTRIBUTION-CONNECTION-SRC-W1 — unit tests for the connection-layer source
 * SoT (src/lib/attribution-sources.ts). Pure logic; no DB / network.
 *
 * Covers: enum membership (incl. the Cowork A4 decisions — `direct` dropped,
 * `npm` retained as placeholder), default-deny `?src=` validation, the
 * resolveSource precedence (deterministic ?src → heuristic UA → unknown), and
 * the connect-dedup LRU.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_SOURCES,
  isAttributionSource,
  normalizeSrcParam,
  resolveSource,
  shouldEmitConnect,
  _resetConnectDedupForTest,
} from '../src/lib/attribution-sources.js';

describe('attribution-sources — SoT enum', () => {
  it('contains the Cowork-ratified slug set; drops `direct`; keeps `npm` + `unknown`', () => {
    const set = new Set(ATTRIBUTION_SOURCES);
    for (const s of [
      'chatgpt', 'claude', 'smithery', 'glama', 'pulsemcp', 'mcp_so',
      'bazaar', 'agentkit', 'elizaos', 'llamahub', 'npm', 'github', 'docs', 'x', 'unknown',
      // FUNNEL-FIX-ATTRIBUTION-W1 ratified additions (LLM-client + inbound-referrer channels):
      'cursor', 'windsurf', 'cline', 'continue', 'zed', 'copilot',
      'devto', 'medium', 'lobehub', 'producthunt', 'reddit', 'organic',
      // OPS-ATTRIBUTION-AI-REFERRAL-W1 — ai_* human-referral family (DISTINCT from agent chatgpt/claude):
      'ai_chatgpt', 'ai_perplexity', 'ai_claude', 'ai_gemini', 'ai_copilot', 'ai_grok',
    ]) {
      expect(set.has(s as never)).toBe(true);
    }
    // no conflation: the agent UA slug and the ai_* human-referral slug both exist and are distinct.
    expect(set.has('chatgpt' as never) && set.has('ai_chatgpt' as never)).toBe(true);
    // A4: `direct` was intentionally dropped (an untagged connect is `unknown`).
    expect(set.has('direct' as never)).toBe(false);
    // 15 original + 12 FUNNEL-FIX-ATTRIBUTION-W1 + 6 OPS-ATTRIBUTION-AI-REFERRAL-W1 = 33 slugs, no dupes.
    expect(ATTRIBUTION_SOURCES.length).toBe(33);
    expect(new Set(ATTRIBUTION_SOURCES).size).toBe(33);
  });

  it('isAttributionSource is a correct type guard', () => {
    expect(isAttributionSource('chatgpt')).toBe(true);
    expect(isAttributionSource('unknown')).toBe(true);
    expect(isAttributionSource('direct')).toBe(false);
    expect(isAttributionSource('nope')).toBe(false);
    expect(isAttributionSource(42)).toBe(false);
    expect(isAttributionSource(null)).toBe(false);
  });
});

describe('attribution-sources — normalizeSrcParam (default-deny, no length floor)', () => {
  it('accepts known slugs, case-insensitive + trimmed', () => {
    expect(normalizeSrcParam('chatgpt')).toBe('chatgpt');
    expect(normalizeSrcParam('  ChatGPT  ')).toBe('chatgpt');
    expect(normalizeSrcParam('MCP_SO')).toBe('mcp_so');
    // short slugs are valid (no TOKEN_RE 8-char floor — validated against the enum)
    expect(normalizeSrcParam('x')).toBe('x');
    expect(normalizeSrcParam('npm')).toBe('npm');
  });

  it('default-denies unknown / malformed / non-string', () => {
    expect(normalizeSrcParam('garbage')).toBeNull();
    expect(normalizeSrcParam('direct')).toBeNull(); // dropped slug → not accepted
    expect(normalizeSrcParam('')).toBeNull();
    expect(normalizeSrcParam(undefined)).toBeNull();
    expect(normalizeSrcParam(['chatgpt'])).toBeNull(); // array (repeated ?src=) not trusted
    expect(normalizeSrcParam(123)).toBeNull();
  });
});

describe('attribution-sources — resolveSource precedence', () => {
  it('?src= known slug → deterministic', () => {
    expect(resolveSource({ srcParam: 'chatgpt' })).toEqual({
      source: 'chatgpt',
      source_confidence: 'deterministic',
    });
    expect(resolveSource({ srcParam: 'SMITHERY' })).toEqual({
      source: 'smithery',
      source_confidence: 'deterministic',
    });
  });

  it('no ?src= + known UA → heuristic', () => {
    expect(
      resolveSource({ userAgent: 'ChatGPT-User/1.0 (+https://openai.com)' }),
    ).toEqual({ source: 'chatgpt', source_confidence: 'heuristic' });
    expect(resolveSource({ userAgent: 'Claude-User claude.ai' })).toEqual({
      source: 'claude',
      source_confidence: 'heuristic',
    });
  });

  it('unrecognized ?src= is NOT trusted — falls through to UA, then unknown', () => {
    // garbage src + chatgpt UA → heuristic chatgpt (src ignored)
    expect(
      resolveSource({ srcParam: 'totally-made-up', userAgent: 'openai-connector' }),
    ).toEqual({ source: 'chatgpt', source_confidence: 'heuristic' });
    // garbage src + no UA → unknown/unknown
    expect(resolveSource({ srcParam: 'totally-made-up' })).toEqual({
      source: 'unknown',
      source_confidence: 'unknown',
    });
  });

  it('no signal / unknown client UA → unknown/unknown (default-deny)', () => {
    expect(resolveSource({})).toEqual({ source: 'unknown', source_confidence: 'unknown' });
    expect(resolveSource({ userAgent: 'Cursor/0.42 node' })).toEqual({
      source: 'unknown',
      source_confidence: 'unknown',
    });
    expect(resolveSource({ userAgent: '' })).toEqual({
      source: 'unknown',
      source_confidence: 'unknown',
    });
  });

  it('deterministic ?src= wins even when UA would heuristic-match a DIFFERENT source', () => {
    // explicit src=claude on a chatgpt UA → trust the explicit tag
    expect(
      resolveSource({ srcParam: 'claude', userAgent: 'ChatGPT-User openai' }),
    ).toEqual({ source: 'claude', source_confidence: 'deterministic' });
  });
});

describe('attribution-sources — connect dedup LRU', () => {
  afterEach(() => _resetConnectDedupForTest());

  it('emits once per session, suppresses repeats, distinct per session', () => {
    expect(shouldEmitConnect('sess-A')).toBe(true);
    expect(shouldEmitConnect('sess-A')).toBe(false);
    expect(shouldEmitConnect('sess-A')).toBe(false);
    expect(shouldEmitConnect('sess-B')).toBe(true);
    expect(shouldEmitConnect('sess-B')).toBe(false);
  });

  it('reset clears the LRU (re-emits after reset)', () => {
    expect(shouldEmitConnect('sess-C')).toBe(true);
    expect(shouldEmitConnect('sess-C')).toBe(false);
    _resetConnectDedupForTest();
    expect(shouldEmitConnect('sess-C')).toBe(true);
  });
});
