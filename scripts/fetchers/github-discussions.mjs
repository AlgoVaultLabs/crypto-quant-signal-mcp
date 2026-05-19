// scripts/fetchers/github-discussions.mjs
// BUNDLE-EXPAND-BLOG-W1 (C1, 2026-05-19) — fetch AlgoVaultLabs/crypto-quant-signal-mcp
// GitHub Discussions via `gh api graphql` (uses operator's gh CLI auth in container).
//
// Graceful-degradation contract: returns [] + WARNING log on any error path.
// Never throws — preserves the Promise.allSettled() invariant in the cron orchestrator.

import { execFileSync } from 'node:child_process';

const sourceType = 'github_discussion';

const QUERY = `
  query {
    repository(owner: "AlgoVaultLabs", name: "crypto-quant-signal-mcp") {
      discussions(first: 50, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes {
          number
          title
          url
          body
          createdAt
          category { name }
          author { login }
        }
      }
    }
  }
`.replace(/\s+/g, ' ').trim();

async function fetchAll() {
  let json;
  try {
    // execFileSync avoids shell-quoting issues with the JSON-like query string.
    const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${QUERY}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    json = JSON.parse(out);
  } catch (err) {
    console.warn(
      `[fetcher:github_discussion] gh api graphql failed (returning []): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }

  const nodes = json?.data?.repository?.discussions?.nodes ?? [];
  const pages = nodes
    .filter((d) => typeof d?.title === 'string' && typeof d?.body === 'string' && d.body.trim().length > 50)
    .map((d) => ({
      source_type: sourceType,
      source_url: d.url,
      title: d.title,
      published_at: d.createdAt,
      content_markdown: d.body,
      author: d.author?.login ?? 'AlgoVault Labs',
      tags: d.category?.name ? [d.category.name] : [],
    }));

  console.log(`[fetcher:github_discussion] returning ${pages.length} pages`);
  return pages;
}

export default { sourceType, fetchAll };
