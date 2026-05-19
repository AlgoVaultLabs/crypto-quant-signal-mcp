// scripts/fetchers/types.mjs
// Shared types for BUNDLE-EXPAND-BLOG-W1 fetchers (2026-05-19).
//
// Adding a new content source = create a new fetcher module that implements
// the `Fetcher` interface (sourceType + fetchAll). Register in
// `scripts/refresh-knowledge-pages.mjs`'s FETCHERS array. Zero schema migration.
//
// Sources (post-Mr.1 Q-5 ratification 2026-05-19):
//   ✅ devto              — dev.to API; handle `algovaultlabs` (lowercase, trailing s)
//   ✅ medium             — Medium RSS;  handle `algovault`     (lowercase, no labs)
//   ✅ youtube            — YouTube Data API v3; handle `@AlgoVaultLabs` (mixed case)
//   ✅ github_discussion  — gh api graphql; AlgoVaultLabs/crypto-quant-signal-mcp
//   ❌ algovault_blog     — DROPPED (Q-5: dev.to IS canonical blog surface;
//                            /var/www/algovault/blog absent + sitemap.xml /blog/ = 0)
//   ❌ hashnode           — DROPPED (always strips AlgoVault posts per Mr.1 2026-05-19)
//   ⏸ x                  — DEFERRED to W2 (low knowledge density per post)

/**
 * @typedef {object} BundlePage
 * @property {'devto' | 'medium' | 'youtube' | 'github_discussion'} source_type
 * @property {string} source_url            - canonical URL (dedup key)
 * @property {string} title
 * @property {string} published_at          - ISO 8601 UTC
 * @property {string} content_markdown      - body for blogs/discussions; transcript or description for video
 * @property {string} [author]
 * @property {string[]} [tags]
 * @property {number} [duration_seconds]    - YouTube only
 * @property {string} [thumbnail_url]       - YouTube only
 */

/**
 * @typedef {object} Fetcher
 * @property {string} sourceType            - matches BundlePage.source_type
 * @property {function(): Promise<BundlePage[]>} fetchAll
 */

export const SOURCE_TYPES = /** @type {const} */ ([
  'devto',
  'medium',
  'youtube',
  'github_discussion',
]);
