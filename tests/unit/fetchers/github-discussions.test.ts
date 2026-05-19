/**
 * BUNDLE-EXPAND-BLOG-W1 (C3) — GitHub Discussions fetcher graceful-degradation contract.
 *
 * Uses execFileSync('gh', ['api', 'graphql', ...]) — mocked via vi.mock so the
 * test doesn't depend on the operator's actual gh CLI auth state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execMock(...args),
}));

describe('github-discussions fetcher', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it('returns [] when gh CLI exits non-zero', async () => {
    execMock.mockImplementation(() => {
      throw new Error('gh exit code 1: auth required');
    });
    const gh = (await import('../../../scripts/fetchers/github-discussions.mjs')).default;
    const pages = await gh.fetchAll();
    expect(pages).toEqual([]);
  });

  it('parses valid GraphQL response into BundlePage shape', async () => {
    execMock.mockReturnValueOnce(
      JSON.stringify({
        data: {
          repository: {
            discussions: {
              nodes: [
                {
                  number: 12,
                  title: 'v1.15.0 — new chat_knowledge tool',
                  url: 'https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/discussions/12',
                  body: 'We just shipped chat_knowledge as a new MCP tool. It lets agents ask natural-language questions about AlgoVault and get cited answers.',
                  createdAt: '2026-05-18T10:00:00Z',
                  category: { name: 'Announcements' },
                  author: { login: 'AlgoVaultLabs' },
                },
              ],
            },
          },
        },
      }),
    );
    const gh = (await import('../../../scripts/fetchers/github-discussions.mjs')).default;
    const pages = await gh.fetchAll();
    expect(pages).toHaveLength(1);
    expect(pages[0].source_type).toBe('github_discussion');
    expect(pages[0].source_url).toContain('/discussions/12');
    expect(pages[0].title).toContain('v1.15.0');
    expect(pages[0].content_markdown).toContain('chat_knowledge');
    expect(pages[0].tags).toEqual(['Announcements']);
  });

  it('returns [] when gh returns malformed JSON', async () => {
    execMock.mockReturnValueOnce('not json at all');
    const gh = (await import('../../../scripts/fetchers/github-discussions.mjs')).default;
    const pages = await gh.fetchAll();
    expect(pages).toEqual([]);
  });

  it('filters out discussions with body < 50 chars', async () => {
    execMock.mockReturnValueOnce(
      JSON.stringify({
        data: {
          repository: {
            discussions: {
              nodes: [
                { number: 1, title: 'tiny', url: 'https://github.com/x/d/1', body: 'too short', createdAt: '2026-05-18T10:00:00Z', category: {}, author: {} },
                { number: 2, title: 'long enough', url: 'https://github.com/x/d/2', body: 'a'.repeat(100), createdAt: '2026-05-18T10:00:00Z', category: { name: 'Announcements' }, author: { login: 'foo' } },
              ],
            },
          },
        },
      }),
    );
    const gh = (await import('../../../scripts/fetchers/github-discussions.mjs')).default;
    const pages = await gh.fetchAll();
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe('long enough');
  });
});
