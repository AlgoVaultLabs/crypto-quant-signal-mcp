// scripts/fetchers/devto.mjs — PAUSED (OPS-DEVTO-SPAM-GUARD-W1 CH2, 2026-10-05, ruling Q1 = C).
//
// BUNDLE-EXPAND-BLOG-W1 (2026-05-19) read the account's articles with an operator key — under an env var
// name production never set, so this source returned [] on every weekly refresh it ever ran (20 of 20
// since 2026-05-24). A key-less rewrite would have ingested up to 117 posts into the public knowledge
// bundle on the first refresh after the dev.to account is restored: a first-ever ingestion nobody
// approved. So the source is PAUSED: it returns [] with one log line, holds no credential and makes no
// request. signal-MCP holds no dev.to API reference at all (tests/unit/no-devto-write-path.test.ts, empty
// allowlist). Ingesting our posts again is its own future spec, reading our own published bodies — never
// the dev.to API.
//
// The registry entry stays (scripts/refresh-knowledge-pages.mjs FETCHERS) so each refresh still names
// the source and logs why it is empty.

const sourceType = 'devto';

async function fetchAll() {
  console.log('[fetcher:devto] source paused (OPS-DEVTO-SPAM-GUARD-W1) — returning []');
  return [];
}

export default { sourceType, fetchAll };
