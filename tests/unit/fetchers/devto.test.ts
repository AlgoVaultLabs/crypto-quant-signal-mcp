/**
 * BUNDLE-EXPAND-BLOG-W1 (C3) — dev.to fetcher graceful-degradation contract.
 *
 * Locks: returns [] + no throw on every error path (absent key, HTTP error,
 * malformed JSON, network failure). Valid response → BundlePage[] shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('devto fetcher', () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.DEV_TO_API_KEY;

  beforeEach(() => {
    delete process.env.DEV_TO_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.DEV_TO_API_KEY;
    else process.env.DEV_TO_API_KEY = realKey;
  });

  it('returns [] when DEV_TO_API_KEY unset (graceful degradation)', async () => {
    const devto = (await import('../../../scripts/fetchers/devto.mjs')).default;
    const pages = await devto.fetchAll();
    expect(pages).toEqual([]);
  });

  it('returns [] on HTTP error (graceful degradation)', async () => {
    process.env.DEV_TO_API_KEY = 'fake-key';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as unknown as typeof globalThis.fetch;
    const devto = (await import('../../../scripts/fetchers/devto.mjs')).default;
    const pages = await devto.fetchAll();
    expect(pages).toEqual([]);
  });

  it('parses valid response into BundlePage shape', async () => {
    process.env.DEV_TO_API_KEY = 'fake-key';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          url: 'https://dev.to/algovaultlabs/the-data-flywheel-how-46k-calls-feed-weekly-weight-retuning-abc',
          title: 'The data flywheel',
          published_at: '2026-05-19T08:00:00Z',
          body_markdown: 'AlgoVault publishes signals every minute; the data flywheel turns each call into a measurement.',
          description: 'short summary',
          user: { username: 'algovaultlabs', name: 'AlgoVault Labs' },
          tag_list: ['crypto', 'trading', 'mcp'],
        },
      ],
    }) as unknown as typeof globalThis.fetch;

    const devto = (await import('../../../scripts/fetchers/devto.mjs')).default;
    const pages = await devto.fetchAll();
    expect(pages).toHaveLength(1);
    expect(pages[0].source_type).toBe('devto');
    expect(pages[0].source_url).toContain('dev.to/algovaultlabs/');
    expect(pages[0].title).toBe('The data flywheel');
    expect(pages[0].published_at).toBe('2026-05-19T08:00:00Z');
    expect(pages[0].content_markdown).toContain('data flywheel');
    expect(pages[0].author).toBe('algovaultlabs');
    expect(pages[0].tags).toEqual(['crypto', 'trading', 'mcp']);
  });

  it('returns [] on fetch throw (network failure)', async () => {
    process.env.DEV_TO_API_KEY = 'fake-key';
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof globalThis.fetch;
    const devto = (await import('../../../scripts/fetchers/devto.mjs')).default;
    const pages = await devto.fetchAll();
    expect(pages).toEqual([]);
  });

  it('filters out posts with content_markdown < 50 chars', async () => {
    process.env.DEV_TO_API_KEY = 'fake-key';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { url: 'https://dev.to/x/a', title: 'tiny', published_at: '2026-05-19T08:00:00Z', body_markdown: 'too short', user: {} },
        { url: 'https://dev.to/x/b', title: 'big enough', published_at: '2026-05-19T08:00:00Z', body_markdown: 'a'.repeat(100), user: {} },
      ],
    }) as unknown as typeof globalThis.fetch;
    const devto = (await import('../../../scripts/fetchers/devto.mjs')).default;
    const pages = await devto.fetchAll();
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe('big enough');
  });
});
