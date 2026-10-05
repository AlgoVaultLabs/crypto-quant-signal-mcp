/**
 * OPS-DEVTO-SPAM-GUARD-W1 CH2 (ruling Q1 = C) — the dev.to knowledge source is PAUSED.
 *
 * Locks: fetchAll() returns [] with exactly one log line, makes NO network request, reads NO credential
 * env var, and never throws. (BUNDLE-EXPAND-BLOG-W1's authenticated fetch read an env var production
 * never set and returned [] on all 20 refreshes; a key-less rewrite would have ingested up to 117 posts
 * on restore. Re-enabling ingestion is its own future spec.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('devto fetcher (paused)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('returns [] with the paused log line, and never calls fetch — even with a key-shaped env present', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('must not be called'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.DEV_TO_API_KEY = 'would-have-been-used';
    process.env.DEVTO_API_KEY = 'would-have-been-used';
    try {
      const devto = (await import('../../../scripts/fetchers/devto.mjs')).default;
      expect(devto.sourceType).toBe('devto');
      await expect(devto.fetchAll()).resolves.toEqual([]);
    } finally {
      delete process.env.DEV_TO_API_KEY;
      delete process.env.DEVTO_API_KEY;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(['[fetcher:devto] source paused (OPS-DEVTO-SPAM-GUARD-W1) — returning []']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the module source holds no credential read and no dev.to API URL', () => {
    const src = readFileSync(path.resolve(__dirname, '../../../scripts/fetchers/devto.mjs'), 'utf8');
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/dev\.to\/api\//);
    expect(src).not.toMatch(/api-key/i);
  });
});
