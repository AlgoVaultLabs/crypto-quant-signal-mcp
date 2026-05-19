// scripts/fetchers/devto.mjs
// BUNDLE-EXPAND-BLOG-W1 (C2, 2026-05-19) — fetch AlgoVault's published dev.to
// articles via Forem API v1 (api-key header auth).
//
// Public handle: `algovaultlabs` (lowercase, trailing s) per Mr.1 Q-4
// ratification (handle is for URL verification only; API uses operator's
// DEV_TO_API_KEY against the `me/published` endpoint).
//
// Graceful-degradation contract: returns [] + WARNING log on any error path.
// Never throws.

const sourceType = 'devto';

async function fetchAll() {
  const apiKey = process.env.DEV_TO_API_KEY;
  if (!apiKey) {
    console.warn('[fetcher:devto] DEV_TO_API_KEY not set — returning [] (graceful degradation)');
    return [];
  }
  try {
    const res = await fetch('https://dev.to/api/articles/me/published?per_page=100', {
      headers: { 'api-key': apiKey, Accept: 'application/vnd.forem.api-v1+json' },
    });
    if (!res.ok) {
      console.warn(`[fetcher:devto] HTTP ${res.status} — returning [] (graceful degradation)`);
      return [];
    }
    const articles = await res.json();
    if (!Array.isArray(articles)) {
      console.warn('[fetcher:devto] response is not an array — returning []');
      return [];
    }
    const pages = articles
      .filter((a) => a && typeof a.url === 'string' && typeof a.title === 'string')
      .map((a) => ({
        source_type: sourceType,
        source_url: a.url,
        title: a.title,
        published_at: a.published_at ?? new Date().toISOString(),
        content_markdown:
          typeof a.body_markdown === 'string' && a.body_markdown.length > 0
            ? a.body_markdown
            : a.description ?? '',
        author: a.user?.username ?? a.user?.name ?? 'AlgoVault Labs',
        tags: Array.isArray(a.tag_list) ? a.tag_list : [],
      }))
      .filter((p) => p.content_markdown.length > 50);

    console.log(`[fetcher:devto] returning ${pages.length} pages`);
    return pages;
  } catch (err) {
    console.warn(
      `[fetcher:devto] fetch failed (returning []): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

export default { sourceType, fetchAll };
