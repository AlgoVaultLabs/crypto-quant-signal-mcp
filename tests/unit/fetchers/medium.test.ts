/**
 * BUNDLE-EXPAND-BLOG-W1 (C3) — Medium RSS fetcher graceful-degradation contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('medium fetcher', () => {
  const realFetch = globalThis.fetch;
  const realHandle = process.env.MEDIUM_AUTHOR_HANDLE;

  beforeEach(() => {
    delete process.env.MEDIUM_AUTHOR_HANDLE;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realHandle === undefined) delete process.env.MEDIUM_AUTHOR_HANDLE;
    else process.env.MEDIUM_AUTHOR_HANDLE = realHandle;
  });

  it('returns [] on HTTP non-OK', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof globalThis.fetch;
    const medium = (await import('../../../scripts/fetchers/medium.mjs')).default;
    const pages = await medium.fetchAll();
    expect(pages).toEqual([]);
  });

  it('parses valid RSS into BundlePage shape', async () => {
    const sampleRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>AlgoVault Labs on Medium</title>
    <item>
      <title>Cross-venue funding arbitrage</title>
      <link>https://medium.com/@algovault/cross-venue-funding-arbitrage-abc123</link>
      <pubDate>Mon, 19 May 2026 08:00:00 GMT</pubDate>
      <dc:creator>AlgoVault Labs</dc:creator>
      <content:encoded>&lt;p&gt;Cross-venue funding arbitrage is the simplest cash-and-carry trade an AI agent can run continuously.&lt;/p&gt;&lt;p&gt;The arbitrage works by going long on the venue with negative funding and short on the venue with positive funding.&lt;/p&gt;</content:encoded>
      <category>arbitrage</category>
      <category>crypto</category>
    </item>
  </channel>
</rss>`;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => sampleRss,
    }) as unknown as typeof globalThis.fetch;

    const medium = (await import('../../../scripts/fetchers/medium.mjs')).default;
    const pages = await medium.fetchAll();
    expect(pages).toHaveLength(1);
    expect(pages[0].source_type).toBe('medium');
    expect(pages[0].source_url).toContain('medium.com/@algovault/cross-venue-funding-arbitrage');
    expect(pages[0].title).toBe('Cross-venue funding arbitrage');
    expect(pages[0].content_markdown).toContain('arbitrage');
    expect(pages[0].content_markdown).not.toContain('<p>'); // HTML stripped
    expect(pages[0].author).toBe('AlgoVault Labs');
    expect(pages[0].tags).toEqual(['arbitrage', 'crypto']);
  });

  it('returns [] on fetch throw', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND')) as unknown as typeof globalThis.fetch;
    const medium = (await import('../../../scripts/fetchers/medium.mjs')).default;
    const pages = await medium.fetchAll();
    expect(pages).toEqual([]);
  });

  it('uses default handle @algovault when MEDIUM_AUTHOR_HANDLE unset', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;
    const medium = (await import('../../../scripts/fetchers/medium.mjs')).default;
    await medium.fetchAll();
    expect(spy).toHaveBeenCalledWith('https://medium.com/feed/@algovault', expect.any(Object));
  });
});
