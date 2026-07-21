import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs deploy script, no type decls (CLI helper)
import { buildIndexNowPayload } from '../../scripts/indexnow-ping.mjs';

// AI-CRAWLER-ACCESS-W2 R3 — IndexNow payload builder.
describe('indexnow-ping buildIndexNowPayload', () => {
  it('builds a valid IndexNow payload from the live landing/ + sitemap', () => {
    const p = buildIndexNowPayload();
    expect(p).not.toBeNull();
    expect(p.host).toBe('algovault.com');
    // key = 32-hex, single source of truth = the landing/<key>.txt file
    expect(p.key).toMatch(/^[0-9a-f]{32}$/);
    expect(p.keyLocation).toBe(`https://algovault.com/${p.key}.txt`);
    expect(Array.isArray(p.urlList)).toBe(true);
    expect(p.urlList.length).toBeGreaterThan(10);
    // homepage present; verified-404 pages must NOT be submitted
    expect(p.urlList).toContain('https://algovault.com/');
    expect(p.urlList.some((u: string) => u.includes('/pricing'))).toBe(false);
    // OPS-INTEGRATIONS-VENUE-PAGES-W1: /integrations/hyperliquid was asserted
    // ABSENT here because it was a verified 404 — the venue had no page. This
    // wave shipped it (plus aster/bingx/kucoin), so the exemption and the
    // assertion that encoded it flip together: these are real 200s now and
    // SHOULD be submitted. Leaving the old assertion would have quietly kept
    // four live pages out of the crawl-submission set.
    for (const slug of ['hyperliquid', 'aster', 'bingx', 'kucoin']) {
      expect(
        p.urlList.some((u: string) => u.includes(`/integrations/${slug}`)),
        `/integrations/${slug} should be submitted to IndexNow`,
      ).toBe(true);
    }
    // every URL is an https apex URL (no www, no http)
    for (const u of p.urlList) {
      expect(u.startsWith('https://algovault.com/')).toBe(true);
    }
  });

  it('returns null when no key file is present (fail-open contract)', () => {
    const p = buildIndexNowPayload({ landingDir: '/tmp/nonexistent-indexnow-dir-xyz-123' });
    expect(p).toBeNull();
  });
});
