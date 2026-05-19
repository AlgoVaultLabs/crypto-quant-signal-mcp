// scripts/fetchers/medium.mjs
// BUNDLE-EXPAND-BLOG-W1 (C2, 2026-05-19) — fetch AlgoVault's Medium articles
// via the public RSS feed.
//
// Public handle: `algovault` (lowercase, NO "labs" suffix) per Mr.1 Q-3
// ratification — confirmed live via `curl https://medium.com/feed/@algovault`
// HTTP 200 at 2026-05-19 18:14 UTC Plan-Mode probe.
//
// Graceful-degradation contract: returns [] + WARNING log on any error path.
// Never throws.

import { XMLParser } from 'fast-xml-parser';

const sourceType = 'medium';

function stripHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchAll() {
  const handle = process.env.MEDIUM_AUTHOR_HANDLE || 'algovault';
  try {
    const res = await fetch(`https://medium.com/feed/@${handle}`, {
      headers: { 'User-Agent': 'AlgoVault-knowledge-bundle/1.0' },
    });
    if (!res.ok) {
      console.warn(
        `[fetcher:medium] RSS HTTP ${res.status} for @${handle} — returning [] (scrape fallback deferred to W2)`,
      );
      return [];
    }
    const xml = await res.text();
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(xml);
    const items = parsed?.rss?.channel?.item ?? [];
    const arr = Array.isArray(items) ? items : [items];
    const pages = arr
      .filter((it) => it && typeof it.link === 'string' && typeof it.title === 'string')
      .map((it) => {
        const html = it['content:encoded'] ?? it.description ?? '';
        return {
          source_type: sourceType,
          source_url: it.link,
          title: it.title,
          published_at: it.pubDate ? new Date(it.pubDate).toISOString() : new Date().toISOString(),
          content_markdown: stripHtml(html),
          author: it['dc:creator'] ?? 'AlgoVault Labs',
          tags: Array.isArray(it.category)
            ? it.category.map(String)
            : [it.category].filter((c) => typeof c === 'string'),
        };
      })
      .filter((p) => p.content_markdown.length > 50);

    console.log(`[fetcher:medium] returning ${pages.length} pages (handle=@${handle})`);
    return pages;
  } catch (err) {
    console.warn(
      `[fetcher:medium] fetch failed (returning []): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

export default { sourceType, fetchAll };
