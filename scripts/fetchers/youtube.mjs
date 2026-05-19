// scripts/fetchers/youtube.mjs
// BUNDLE-EXPAND-BLOG-W1 (C2, 2026-05-19) — fetch AlgoVault's YouTube channel
// videos via YouTube Data API v3 (key auth from operator's GCloud project
// `algovaultlabs@gmail.com` per project_algovault_brand_account memory).
//
// Public handle: `@AlgoVaultLabs` (mixed case) per Mr.1 Q-2 ratification.
//
// Transcript fetching is best-effort: the YouTube Data API does NOT expose
// transcript text directly via the channels/videos endpoints. A separate
// captions endpoint exists but requires per-video OAuth on most channels.
// W1 ships with metadata + description as content_markdown; transcript
// scrape (via youtube-transcript npm or yt-dlp shell-out) is a W2 candidate.
//
// Graceful-degradation contract: returns [] + WARNING log on any error path.
// Never throws.

const sourceType = 'youtube';

async function fetchAll() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const channelHandle = process.env.YOUTUBE_CHANNEL_HANDLE || '@AlgoVaultLabs';
  if (!apiKey) {
    console.warn('[fetcher:youtube] YOUTUBE_API_KEY not set — returning [] (graceful degradation)');
    return [];
  }
  try {
    // 1. Resolve channel ID from handle (handle MUST include leading @).
    const handleParam = channelHandle.startsWith('@') ? channelHandle : `@${channelHandle}`;
    const chRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handleParam)}&key=${encodeURIComponent(apiKey)}`,
    );
    if (!chRes.ok) {
      console.warn(`[fetcher:youtube] channel lookup HTTP ${chRes.status} for ${handleParam} — returning []`);
      return [];
    }
    const chJson = await chRes.json();
    const channelId = chJson?.items?.[0]?.id;
    if (!channelId) {
      console.warn(`[fetcher:youtube] channel not found for handle ${handleParam} — returning []`);
      return [];
    }

    // 2. List recent uploads via search.list (ordered by date, type=video).
    const uplRes = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=50&order=date&type=video&key=${encodeURIComponent(apiKey)}`,
    );
    if (!uplRes.ok) {
      console.warn(`[fetcher:youtube] search.list HTTP ${uplRes.status} — returning []`);
      return [];
    }
    const uplJson = await uplRes.json();
    const items = Array.isArray(uplJson?.items) ? uplJson.items : [];

    const pages = items
      .filter(
        (it) =>
          it?.id?.videoId &&
          typeof it.snippet?.title === 'string' &&
          typeof it.snippet?.publishedAt === 'string',
      )
      .map((it) => {
        const vid = it.id.videoId;
        const description = typeof it.snippet.description === 'string' ? it.snippet.description : '';
        return {
          source_type: sourceType,
          source_url: `https://www.youtube.com/watch?v=${vid}`,
          title: it.snippet.title,
          published_at: it.snippet.publishedAt,
          // W1 ships with description-as-content; transcript scrape deferred to W2.
          content_markdown: description,
          author: it.snippet.channelTitle ?? 'AlgoVault Labs',
          thumbnail_url: it.snippet.thumbnails?.high?.url ?? it.snippet.thumbnails?.default?.url,
        };
      })
      .filter((p) => p.content_markdown.length > 50);

    console.log(`[fetcher:youtube] returning ${pages.length} pages (handle=${handleParam})`);
    return pages;
  } catch (err) {
    console.warn(
      `[fetcher:youtube] fetch failed (returning []): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

export default { sourceType, fetchAll };
