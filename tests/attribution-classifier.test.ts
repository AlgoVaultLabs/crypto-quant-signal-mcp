/**
 * FUNNEL-FIX-ATTRIBUTION-W1 — classifySource() + referer + LLM-client map (pure).
 * AC2 (LLM clients / referrers no longer 'unknown'), precedence, default-deny to 'unknown',
 * and the log-only unmatched-UA sampler (no DB / no PII).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifySource, classifyReferer, resolveSource, mediumForSource, normalizeUtmSource, AI_REFERRAL_SOURCES, ATTRIBUTION_SOURCES } from '../src/lib/attribution-sources.js';
import { matchLlmClientUa, logUnmatchedUa, _resetUaSamplesForTest } from '../src/lib/llm-clients.js';
import { taggedLink, isInternalOrRelative } from '../src/lib/tagged-link.js';

describe('classifySource — precedence + medium/confidence', () => {
  it('(1) explicit ?src= wins, deterministic', () => {
    expect(classifySource({ srcParam: 'producthunt', referer: 'https://x.com/a', userAgent: 'claude' }))
      .toEqual({ source: 'producthunt', medium: 'listing', confidence: 'deterministic' });
  });
  it('(1b) legacy ?utm_source= classifies when no ?src=; ?src wins when both (OPS-UTM-SHORTEN-W1)', () => {
    expect(classifySource({ utmSource: 'reddit' }))
      .toEqual({ source: 'reddit', medium: 'referral', confidence: 'deterministic' });
    // ?src= wins over legacy ?utm_source= when both present
    expect(classifySource({ srcParam: 'npm', utmSource: 'reddit' }).source).toBe('npm');
    // a junk ?src= falls through to a valid legacy ?utm_source=
    expect(classifySource({ srcParam: 'garbage', utmSource: 'x' }).source).toBe('x');
  });
  it('(2) Referer domain when no ?src=, deterministic', () => {
    expect(classifySource({ referer: 'https://dev.to/algovault' }))
      .toEqual({ source: 'devto', medium: 'referral', confidence: 'deterministic' });
    expect(classifySource({ referer: 'https://www.producthunt.com/posts/x' }).source).toBe('producthunt');
    expect(classifySource({ referer: 'https://github.com/AlgoVaultLabs' }).source).toBe('github');
    expect(classifySource({ referer: 'https://www.google.com/search?q=x' })).toMatchObject({ source: 'organic', medium: 'organic' });
  });
  it('(3) LLM-client UA when no ?src/referer, heuristic', () => {
    expect(classifySource({ userAgent: 'claude-user/1.0 anthropic' }))
      .toEqual({ source: 'claude', medium: 'agent', confidence: 'heuristic' });
  });
  it('(4) default-deny to unknown/direct — never fabricated', () => {
    expect(classifySource({ userAgent: 'python-requests/2.31' }))
      .toEqual({ source: 'unknown', medium: 'direct', confidence: 'unknown' });
    expect(classifySource({})).toEqual({ source: 'unknown', medium: 'direct', confidence: 'unknown' });
  });
});

describe('classifyReferer', () => {
  it('maps known hosts (subdomain-safe), null on unknown/unparseable', () => {
    expect(classifyReferer('https://x.com/algovault')).toBe('x');
    expect(classifyReferer('https://mobile.twitter.com/x')).toBe('x');
    expect(classifyReferer('https://lobehub.com/mcp/algovault')).toBe('lobehub');
    expect(classifyReferer('https://some-random-blog.example/x')).toBeNull();
    expect(classifyReferer('not a url')).toBeNull();
    expect(classifyReferer(null)).toBeNull();
    // must not be fooled by a lookalike host containing the brand as a substring
    expect(classifyReferer('https://x.com.evil.example/x')).toBeNull();
  });
});

describe('OPS-ATTRIBUTION-AI-REFERRAL-W1 — ai_* human-referral family (distinct from agent UA channels)', () => {
  it('AC1 — the 6 AI web hosts classify to their ai_* slug (Referer · medium=ai · deterministic)', () => {
    expect(classifySource({ referer: 'https://chatgpt.com/c/abc' })).toEqual({ source: 'ai_chatgpt', medium: 'ai', confidence: 'deterministic' });
    expect(classifySource({ referer: 'https://chat.openai.com/c/abc' }).source).toBe('ai_chatgpt');
    expect(classifySource({ referer: 'https://www.perplexity.ai/search/x' }).source).toBe('ai_perplexity');
    expect(classifySource({ referer: 'https://claude.ai/chat/x' }).source).toBe('ai_claude');
    expect(classifySource({ referer: 'https://gemini.google.com/app' }).source).toBe('ai_gemini');
    expect(classifySource({ referer: 'https://bard.google.com/' }).source).toBe('ai_gemini');
    expect(classifySource({ referer: 'https://copilot.microsoft.com/' }).source).toBe('ai_copilot');
    expect(classifySource({ referer: 'https://grok.com/' }).source).toBe('ai_grok');
  });
  it('AC2 — utm_source=chatgpt.com survives the referer-strip → ai_chatgpt (no referer · Layer 2)', () => {
    expect(classifySource({ utmSource: 'chatgpt.com' })).toEqual({ source: 'ai_chatgpt', medium: 'ai', confidence: 'deterministic' });
    expect(normalizeUtmSource('chatgpt.com')).toBe('ai_chatgpt');
    expect(normalizeUtmSource('reddit')).toBe('reddit');          // legacy short utm slug still classifies
    expect(normalizeUtmSource('totally-made-up.com')).toBeNull(); // unknown utm default-denies
  });
  it('AC3 — ordering: gemini.google.com → ai_gemini NOT organic (ai rule precedes google→organic); plain google stays organic', () => {
    expect(classifySource({ referer: 'https://gemini.google.com/app' }).source).toBe('ai_gemini');
    expect(classifySource({ referer: 'https://www.google.com/search?q=algovault' }).source).toBe('organic');
  });
  it('AC3 — bing.com → organic NOT ai_copilot (conservative; ai_copilot only from copilot.microsoft.com)', () => {
    expect(classifySource({ referer: 'https://www.bing.com/search?q=x' }).source).toBe('organic');
    expect(classifySource({ referer: 'https://bing.com/' }).source).toBe('organic');
  });
  it('AC3 — Grok-on-X (x.com/i/grok) stays social `x` (host-unrecoverable); grok.com → ai_grok; grok.ai dropped', () => {
    expect(classifySource({ referer: 'https://x.com/i/grok' }).source).toBe('x');
    expect(classifySource({ referer: 'https://grok.com/' }).source).toBe('ai_grok');
    expect(classifyReferer('https://grok.ai/')).toBeNull(); // grok.ai intentionally omitted (ownership unverified)
  });
  it('AC1 — NO conflation: an agent chatgpt/claude UA (no referer/utm) stays the agent slug, not ai_*', () => {
    expect(classifySource({ userAgent: 'ChatGPT/1.0' })).toEqual({ source: 'chatgpt', medium: 'agent', confidence: 'heuristic' });
    expect(classifySource({ userAgent: 'claude-user/1.0 anthropic' }).source).toBe('claude');
    // a real AI referer beats a conflicting agent UA (Referer step precedes the UA step)
    expect(classifySource({ referer: 'https://chatgpt.com/x', userAgent: 'claude-user anthropic' }).source).toBe('ai_chatgpt');
  });
  it('subdomain-safe: a look-alike AI host defaults-deny (the $-anchor)', () => {
    expect(classifyReferer('https://chatgpt.com.evil.example/x')).toBeNull();
    expect(classifyReferer('https://claude.ai.evil.example/x')).toBeNull();
  });
  it('mediumForSource maps every ai_* → ai; AI_REFERRAL_SOURCES === the medium==ai set (drift canary)', () => {
    for (const s of AI_REFERRAL_SOURCES) expect(mediumForSource(s)).toBe('ai');
    const byMedium = ATTRIBUTION_SOURCES.filter((s) => mediumForSource(s) === 'ai');
    expect([...byMedium].sort()).toEqual([...AI_REFERRAL_SOURCES].sort());
    expect(AI_REFERRAL_SOURCES.length).toBe(6);
    expect([...AI_REFERRAL_SOURCES]).toContain('ai_chatgpt');
  });
});

describe('matchLlmClientUa — observed-only seed (Mr.1: no guessed UAs)', () => {
  it('matches observed clients; returns null for not-yet-observed (cursor/windsurf)', () => {
    expect(matchLlmClientUa('claude-desktop anthropic')).toBe('claude');
    expect(matchLlmClientUa('ChatGPT/1.0')).toBe('chatgpt');
    expect(matchLlmClientUa('Cursor/0.42')).toBeNull(); // NOT seeded until a real UA is observed
    expect(matchLlmClientUa('')).toBeNull();
  });
});

describe('logUnmatchedUa — log-only sampler (no DB, no PII), deduped + bounded', () => {
  beforeEach(() => _resetUaSamplesForTest());
  it('logs a truncated sample once per distinct UA; skips short/empty', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logUnmatchedUa('SomeNewMcpClient/2.0 (details...)');
    logUnmatchedUa('SomeNewMcpClient/2.0 (details...)'); // dup → no second log
    logUnmatchedUa('');
    logUnmatchedUa(undefined);
    expect(spy.mock.calls.filter(c => String(c[0]).includes('unmatched-UA'))).toHaveLength(1);
    spy.mockRestore();
  });
});

describe('resolveSource back-compat + mediumForSource', () => {
  it('resolveSource still returns {source, source_confidence} (existing capture-hook shape)', () => {
    expect(resolveSource({ srcParam: 'claude' })).toEqual({ source: 'claude', source_confidence: 'deterministic' });
    expect(resolveSource({ utmSource: 'smithery' })).toEqual({ source: 'smithery', source_confidence: 'deterministic' }); // legacy fallback
    expect(resolveSource({ referer: 'https://npmjs.com/package/x' })).toEqual({ source: 'npm', source_confidence: 'deterministic' });
  });
  it('mediumForSource buckets each source; unknown → direct', () => {
    expect(mediumForSource('cursor')).toBe('agent');
    expect(mediumForSource('smithery')).toBe('listing');
    expect(mediumForSource('x')).toBe('social');
    expect(mediumForSource('unknown')).toBe('direct');
  });
});

describe('taggedLink — owned links only, NEVER internal (AC5 canary)', () => {
  it('emits the short ?src=<channel> for AlgoVault hosts; medium arg ignored (OPS-UTM-SHORTEN-W1)', () => {
    expect(taggedLink('https://algovault.com/signup', 'npm')).toContain('src=npm');
    expect(taggedLink('https://algovault.com/signup', 'npm')).not.toContain('utm_medium');
    // the accepted-but-ignored medium arg no longer changes the emit
    expect(taggedLink('https://api.algovault.com/mcp', 'x', 'bio')).toContain('src=x');
    expect(taggedLink('https://api.algovault.com/mcp', 'x', 'bio')).not.toContain('utm_medium');
  });
  it('idempotent on an existing src OR a legacy utm_source (no double-tag)', () => {
    const a = taggedLink('https://algovault.com/?src=existing', 'npm');
    expect(a).toContain('src=existing'); expect(a).not.toContain('src=npm');
    // legacy utm_source preserved — do NOT also add src (the link already classifies)
    const b = taggedLink('https://algovault.com/?utm_source=existing', 'npm');
    expect(b).toContain('utm_source=existing'); expect(b).not.toContain('src=npm');
  });
  it('NEVER tags internal/relative or external links (no attribution laundering)', () => {
    expect(taggedLink('/welcome', 'npm')).toBe('/welcome'); // relative internal → untouched
    expect(taggedLink('/dashboard/funnel', 'x')).toBe('/dashboard/funnel');
    expect(taggedLink('https://evil.com/x', 'npm')).toBe('https://evil.com/x'); // not ours → untouched
    expect(taggedLink('http://algovault.com/x', 'npm')).toBe('http://algovault.com/x'); // non-https → untouched
    expect(taggedLink('https://algovault.com.evil.example/x', 'npm')).toBe('https://algovault.com.evil.example/x'); // lookalike host
  });
  it('isInternalOrRelative flags the never-tag set', () => {
    expect(isInternalOrRelative('/welcome')).toBe(true);
    expect(isInternalOrRelative('https://evil.com')).toBe(true);
    expect(isInternalOrRelative('https://algovault.com/x')).toBe(false);
  });
});
