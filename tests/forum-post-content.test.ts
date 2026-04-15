import { describe, it, expect } from 'vitest';
import { stripExternalUrlsForModeration } from '../src/lib/forum-post-content.js';

describe('stripExternalUrlsForModeration', () => {
  it('strips markdown links to external domains, leaving just the text', () => {
    const input = 'Check out [my blog](https://example.com/blog) for details.';
    const output = stripExternalUrlsForModeration(input);
    expect(output).toBe('Check out my blog for details.');
  });

  it('preserves markdown links to the canonical allowlisted domain', () => {
    const input =
      'See [track record](https://algovault.com/track-record) and [docs](https://docs.example.com/api).';
    const output = stripExternalUrlsForModeration(input, { keepCanonicalDomain: 'algovault.com' });
    expect(output).toBe('See [track record](https://algovault.com/track-record) and docs.');
  });

  it('preserves subdomain of the canonical allowlist (*.algovault.com)', () => {
    const input = 'API at [the MCP endpoint](https://api.algovault.com/mcp).';
    const output = stripExternalUrlsForModeration(input, { keepCanonicalDomain: 'algovault.com' });
    expect(output).toBe('API at [the MCP endpoint](https://api.algovault.com/mcp).');
  });

  it('preserves URLs inside fenced code blocks verbatim', () => {
    const input =
      'Before the code.\n\n```\ncurl https://example.com/api\nwget [fake](https://bogus.test/page)\n```\n\nAfter [link](https://external.test/page).';
    const output = stripExternalUrlsForModeration(input, { keepCanonicalDomain: 'algovault.com' });
    // Inside the fence: untouched.
    expect(output).toContain('curl https://example.com/api');
    expect(output).toContain('wget [fake](https://bogus.test/page)');
    // Outside: link stripped to text, prose URL removed.
    expect(output).toContain('After link.');
    expect(output).not.toContain('https://external.test/page');
  });

  it('preserves URLs inside tilde-fenced (~~~) code blocks too', () => {
    const input = '~~~ts\nconst url = "https://x.example/api";\n~~~\n\nExternal [docs](https://xdocs.example).';
    const output = stripExternalUrlsForModeration(input);
    expect(output).toContain('const url = "https://x.example/api";');
    expect(output).toContain('External docs.');
  });

  it('strips bare http/https URLs from prose', () => {
    const input = 'Live track record: https://algovault.com/track-record\nSome other: https://example.com/x';
    const output = stripExternalUrlsForModeration(input);
    // Both bare URLs should be removed (even canonical — use markdown links for canonical).
    expect(output).not.toMatch(/https?:\/\//);
    // Trailing whitespace is trimmed per line.
    expect(output.split('\n').every((l) => l === l.trimEnd())).toBe(true);
  });

  it('is a no-op on URL-free text', () => {
    const input = 'A quiet paragraph with no links.\n\nAnother line, still quiet.';
    const output = stripExternalUrlsForModeration(input);
    expect(output).toBe(input);
  });

  it('is a no-op on empty string', () => {
    expect(stripExternalUrlsForModeration('')).toBe('');
  });

  it('strips markdown links inside nested lists while keeping list structure', () => {
    const input =
      '- item one with [ext](https://a.test/x)\n  - nested with [algo](https://algovault.com/y)\n- item two';
    const output = stripExternalUrlsForModeration(input, { keepCanonicalDomain: 'algovault.com' });
    expect(output).toContain('- item one with ext');
    expect(output).toContain('  - nested with [algo](https://algovault.com/y)');
    expect(output).toContain('- item two');
  });

  it('does not confuse a parenthesised non-link URL with a markdown link', () => {
    // Plain text with a URL in parens — not a markdown link (no `[...]` before).
    const input = 'A reference (https://example.com/ref) in prose.';
    const output = stripExternalUrlsForModeration(input);
    // The bare URL inside parens should be stripped; the parens stay.
    expect(output).toContain('A reference ()');
    expect(output).not.toContain('https://example.com/ref');
  });
});
