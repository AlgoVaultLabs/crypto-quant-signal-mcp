/**
 * BUNDLE-EXPAND-BLOG-W1 (C3) — YouTube Data API v3 fetcher graceful-degradation contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('youtube fetcher', () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.YOUTUBE_API_KEY;
  const realHandle = process.env.YOUTUBE_CHANNEL_HANDLE;

  beforeEach(() => {
    delete process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_CHANNEL_HANDLE;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = realKey;
    if (realHandle === undefined) delete process.env.YOUTUBE_CHANNEL_HANDLE;
    else process.env.YOUTUBE_CHANNEL_HANDLE = realHandle;
  });

  it('returns [] when YOUTUBE_API_KEY unset (graceful degradation)', async () => {
    const youtube = (await import('../../../scripts/fetchers/youtube.mjs')).default;
    const pages = await youtube.fetchAll();
    expect(pages).toEqual([]);
  });

  it('returns [] when channel handle lookup returns no items', async () => {
    process.env.YOUTUBE_API_KEY = 'fake';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    }) as unknown as typeof globalThis.fetch;
    const youtube = (await import('../../../scripts/fetchers/youtube.mjs')).default;
    const pages = await youtube.fetchAll();
    expect(pages).toEqual([]);
  });

  it('parses 2-stage channel→videos response into BundlePage shape', async () => {
    process.env.YOUTUBE_API_KEY = 'fake';
    const mockFetch = vi.fn();
    // 1st call: channel lookup
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [{ id: 'UCalgovaultlabs' }] }),
    });
    // 2nd call: search.list videos
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            id: { videoId: 'abc123' },
            snippet: {
              title: 'How AlgoVault works under the hood',
              description: 'Long description of how the cross-venue signal aggregation pipeline works behind the AlgoVault MCP server.',
              publishedAt: '2026-05-19T08:00:00Z',
              channelTitle: 'AlgoVault Labs',
              thumbnails: { high: { url: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg' } },
            },
          },
        ],
      }),
    });
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const youtube = (await import('../../../scripts/fetchers/youtube.mjs')).default;
    const pages = await youtube.fetchAll();
    expect(pages).toHaveLength(1);
    expect(pages[0].source_type).toBe('youtube');
    expect(pages[0].source_url).toBe('https://www.youtube.com/watch?v=abc123');
    expect(pages[0].title).toContain('AlgoVault');
    expect(pages[0].thumbnail_url).toContain('ytimg.com');
  });

  it('returns [] on channel lookup HTTP error', async () => {
    process.env.YOUTUBE_API_KEY = 'fake';
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof globalThis.fetch;
    const youtube = (await import('../../../scripts/fetchers/youtube.mjs')).default;
    const pages = await youtube.fetchAll();
    expect(pages).toEqual([]);
  });

  it('uses default handle @AlgoVaultLabs when YOUTUBE_CHANNEL_HANDLE unset', async () => {
    process.env.YOUTUBE_API_KEY = 'fake';
    const spy = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;
    const youtube = (await import('../../../scripts/fetchers/youtube.mjs')).default;
    await youtube.fetchAll();
    const firstUrl = spy.mock.calls[0][0] as string;
    expect(firstUrl).toContain('forHandle=%40AlgoVaultLabs');
  });
});
