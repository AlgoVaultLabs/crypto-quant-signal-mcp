import { describe, it, expect, vi } from 'vitest';
import {
  verifyHashnodePost,
  verifyMoltbookPost,
  verifyDevtoPost,
} from '../src/lib/forum-post-verify.js';

const ZERO_DELAY = { delayMs: 0 };

function mockResponse(status: number, body: unknown, ok?: boolean): Response {
  return {
    ok: ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
  } as unknown as Response;
}

// ── Hashnode ────────────────────────────────────────────────────────────

describe('verifyHashnodePost', () => {
  it('returns verified=true when the re-query returns a real post', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse(200, {
        data: { post: { id: 'abc', slug: 'hello-world', url: 'https://algovault.hashnode.dev/hello-world' } },
      })
    );
    const result = await verifyHashnodePost('abc', 'pat-xyz', 'pub-id', { ...ZERO_DELAY, fetchImpl });
    expect(result).toEqual({
      verified: true,
      platform: 'hashnode',
      url: 'https://algovault.hashnode.dev/hello-world',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0];
    expect(call[0]).toBe('https://gql.hashnode.com');
    expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: 'pat-xyz' });
  });

  it('returns verified=false with a removal reason when post is null (anti-spam dropped)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, { data: { post: null } }));
    const result = await verifyHashnodePost('abc', 'pat', 'pub', { ...ZERO_DELAY, fetchImpl });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.platform).toBe('hashnode');
      expect(result.reason).toContain('hashnode-null-on-requery');
    }
  });

  it('returns verified=false with http status when the re-query HTTP fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(503, null, false));
    const result = await verifyHashnodePost('abc', 'pat', 'pub', { ...ZERO_DELAY, fetchImpl });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toContain('hashnode-http-503');
    }
  });

  it('returns verified=false when GraphQL errors are present', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse(200, {
        errors: [{ message: 'rate limited' }],
        data: null,
      })
    );
    const result = await verifyHashnodePost('abc', 'pat', 'pub', { ...ZERO_DELAY, fetchImpl });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toContain('rate limited');
    }
  });
});

// ── Moltbook ────────────────────────────────────────────────────────────

describe('verifyMoltbookPost', () => {
  it('returns verified=true for a clean post', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse(200, {
        success: true,
        post: {
          id: 'm-1',
          url: 'https://www.moltbook.com/post/m-1',
          is_spam: false,
          is_deleted: false,
          verification_status: 'verified',
        },
      })
    );
    const result = await verifyMoltbookPost('m-1', 'mb-key', { ...ZERO_DELAY, fetchImpl });
    expect(result).toEqual({
      verified: true,
      platform: 'moltbook',
      url: 'https://www.moltbook.com/post/m-1',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('returns verified=false on 404 (not found after publish)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(404, null, false));
    const result = await verifyMoltbookPost('m-1', 'mb-key', { ...ZERO_DELAY, fetchImpl });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toContain('moltbook-not-found');
    }
  });

  it('returns verified=false when is_spam is true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse(200, {
        success: true,
        post: {
          id: 'm-1',
          is_spam: true,
          is_deleted: false,
          verification_status: 'pending',
        },
      })
    );
    const result = await verifyMoltbookPost('m-1', 'mb-key', { ...ZERO_DELAY, fetchImpl });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toContain('moltbook-is_spam');
      expect(result.reason).toContain('verification_status=pending');
    }
  });

  it('returns verified=false when verification_status is pending even without is_spam', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse(200, {
        success: true,
        post: {
          id: 'm-1',
          is_spam: false,
          is_deleted: false,
          verification_status: 'pending',
        },
      })
    );
    const result = await verifyMoltbookPost('m-1', 'mb-key', { ...ZERO_DELAY, fetchImpl });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toContain('moltbook-verification-pending');
    }
  });
});

// ── Dev.to ──────────────────────────────────────────────────────────────

describe('verifyDevtoPost', () => {
  it('returns verified=true when type_of=article and published_at is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse(200, {
        id: 3493463,
        url: 'https://dev.to/algovaultlabs/algovault-mcp-v181-whats-new-47n',
        type_of: 'article',
        published_at: '2026-04-13T08:39:44Z',
      })
    );
    const result = await verifyDevtoPost(3493463, 'devto-key', { ...ZERO_DELAY, fetchImpl });
    expect(result).toEqual({
      verified: true,
      platform: 'devto',
      url: 'https://dev.to/algovaultlabs/algovault-mcp-v181-whats-new-47n',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0];
    expect(call[0]).toBe('https://dev.to/api/articles/3493463');
    expect((call[1] as RequestInit).headers).toMatchObject({ 'api-key': 'devto-key' });
  });

  it('returns verified=false on non-2xx (article not found by id)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(404, null, false));
    const result = await verifyDevtoPost(999999, 'devto-key', { ...ZERO_DELAY, fetchImpl });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toContain('devto-http-404');
    }
  });

  it('returns verified=false when type_of is draft', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse(200, {
        id: 1,
        url: 'https://dev.to/draft',
        type_of: 'draft',
        published_at: null,
      })
    );
    const result = await verifyDevtoPost(1, 'devto-key', { ...ZERO_DELAY, fetchImpl });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toContain('devto-not-published');
      expect(result.reason).toContain('type_of=draft');
    }
  });
});
