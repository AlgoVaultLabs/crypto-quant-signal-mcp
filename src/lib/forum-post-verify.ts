/**
 * forum-post-verify — post-publish verification hooks.
 *
 * Every platform publisher calls into this module ~5 s after a successful
 * API response to re-query the post and confirm it survived moderation.
 * This is the single mitigation that turns the silent-failure window of
 * Hashnode's anti-spam removal + Moltbook's is_spam-flag into a loud
 * failure the rest of the pipeline can react to.
 *
 * Pure except for `fetch` and a single `setTimeout` — the fetch is
 * injectable via the `fetchImpl` option on each function so tests can
 * mock deterministically.
 *
 * Platform-specific gotchas (all verified live 2026-04-15 — see
 * experiments/crypto-quant-signal/platform-api-schemas-2026-04-15.md):
 *   - Hashnode: the canonical-URL field is `originalArticleURL`, not
 *     `canonicalUrl`. We re-query via the top-level `post(id: ID!)`.
 *   - Moltbook: GET /api/v1/posts/:id returns is_spam / verification_status
 *     / is_deleted even though the public github source doesn't declare
 *     them. The route does SELECT p.* so these DB columns flow through.
 *   - Dev.to: GET /api/articles/:id returns no `published` boolean — we
 *     check `type_of === 'article' && published_at != null`.
 */

export type VerifyResult =
  | { verified: true; url: string; platform: string }
  | { verified: false; reason: string; platform: string };

export interface VerifyOptions {
  /** Milliseconds to wait before the re-query. Default 5000. */
  delayMs?: number;
  /** Injected fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Hashnode ────────────────────────────────────────────────────────────

/**
 * Re-query Hashnode after a publish to confirm the post survived the
 * anti-spam filter. The filter silently deletes posts ~seconds after
 * publish; a 5 s delay is the minimum practical debounce.
 *
 * @param postId Post ID returned by the `publishPost` mutation (not slug).
 * @param pat    `HASHNODE_PAT` personal access token.
 * @param pubId  `HASHNODE_PUBLICATION_ID` — unused by the top-level
 *               `post(id:)` query but kept in the signature for future
 *               cross-checks and to match the spec.
 */
export async function verifyHashnodePost(
  postId: string,
  pat: string,
  pubId: string,
  opts: VerifyOptions = {}
): Promise<VerifyResult> {
  void pubId; // signature kept for parity with the spec
  const doFetch = opts.fetchImpl ?? fetch;
  await sleep(opts.delayMs ?? 5000);

  const query = `query VerifyPost($id: ID!) { post(id: $id) { id slug url } }`;
  let res: Response;
  try {
    res = await doFetch('https://gql.hashnode.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: pat },
      body: JSON.stringify({ query, variables: { id: postId } }),
    });
  } catch (err) {
    return {
      verified: false,
      platform: 'hashnode',
      reason: `hashnode-network-error: ${(err as Error).message}`,
    };
  }

  if (!res.ok) {
    return {
      verified: false,
      platform: 'hashnode',
      reason: `hashnode-http-${res.status}`,
    };
  }

  let body: {
    data?: { post?: { id?: string; slug?: string; url?: string } | null };
    errors?: Array<{ message?: string }>;
  };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    return {
      verified: false,
      platform: 'hashnode',
      reason: `hashnode-parse-error: ${(err as Error).message}`,
    };
  }

  if (body.errors && body.errors.length > 0) {
    const msg = body.errors.map((e) => e.message ?? 'unknown').join('; ');
    return {
      verified: false,
      platform: 'hashnode',
      reason: `hashnode-graphql-errors: ${msg}`,
    };
  }

  const post = body.data?.post ?? null;
  if (!post || !post.slug || !post.url) {
    return {
      verified: false,
      platform: 'hashnode',
      reason: 'hashnode-null-on-requery — likely anti-spam removal',
    };
  }

  return { verified: true, platform: 'hashnode', url: post.url };
}

// ── Moltbook ────────────────────────────────────────────────────────────

interface MoltbookPostResponse {
  success?: boolean;
  post?: {
    id?: string;
    url?: string;
    is_spam?: boolean;
    is_deleted?: boolean;
    verification_status?: string;
    title?: string;
  };
}

/**
 * Re-query Moltbook after a publish to confirm the post is not flagged.
 *
 * The auth key is passed for symmetry with the other verifiers, but the
 * read endpoint is public — we still send it so any future ACL change
 * doesn't silently break the hook.
 */
export async function verifyMoltbookPost(
  postId: string,
  apiKey: string,
  opts: VerifyOptions = {}
): Promise<VerifyResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  await sleep(opts.delayMs ?? 5000);

  const url = `https://www.moltbook.com/api/v1/posts/${encodeURIComponent(postId)}`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
  } catch (err) {
    return {
      verified: false,
      platform: 'moltbook',
      reason: `moltbook-network-error: ${(err as Error).message}`,
    };
  }

  if (res.status === 404) {
    return {
      verified: false,
      platform: 'moltbook',
      reason: 'moltbook-not-found (404) — post removed post-publish',
    };
  }
  if (!res.ok) {
    return {
      verified: false,
      platform: 'moltbook',
      reason: `moltbook-http-${res.status}`,
    };
  }

  let body: MoltbookPostResponse;
  try {
    body = (await res.json()) as MoltbookPostResponse;
  } catch (err) {
    return {
      verified: false,
      platform: 'moltbook',
      reason: `moltbook-parse-error: ${(err as Error).message}`,
    };
  }

  const post = body.post;
  if (!post || body.success === false) {
    return {
      verified: false,
      platform: 'moltbook',
      reason: 'moltbook-empty-response',
    };
  }

  if (post.is_deleted === true) {
    return {
      verified: false,
      platform: 'moltbook',
      reason: 'moltbook-is_deleted',
    };
  }

  if (post.is_spam === true) {
    return {
      verified: false,
      platform: 'moltbook',
      reason: `moltbook-is_spam (verification_status=${post.verification_status ?? 'unknown'})`,
    };
  }

  if (post.verification_status === 'rejected') {
    return {
      verified: false,
      platform: 'moltbook',
      reason: 'moltbook-verification-rejected',
    };
  }

  if (post.verification_status === 'pending') {
    return {
      verified: false,
      platform: 'moltbook',
      reason: 'moltbook-verification-pending — agent not verified',
    };
  }

  const resolvedUrl = post.url ?? `https://www.moltbook.com/post/${post.id ?? postId}`;
  return { verified: true, platform: 'moltbook', url: resolvedUrl };
}

// ── Dev.to ──────────────────────────────────────────────────────────────

interface DevtoArticleResponse {
  id?: number;
  url?: string;
  type_of?: string;
  published_at?: string | null;
  title?: string;
}

/**
 * Re-query Dev.to after a publish. Dev.to has been 100% healthy in audit
 * — this hook is a safety net, not an expected failure path.
 */
export async function verifyDevtoPost(
  articleId: number,
  apiKey: string,
  opts: VerifyOptions = {}
): Promise<VerifyResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  await sleep(opts.delayMs ?? 5000);

  const url = `https://dev.to/api/articles/${articleId}`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: { 'api-key': apiKey, Accept: 'application/json' },
    });
  } catch (err) {
    return {
      verified: false,
      platform: 'devto',
      reason: `devto-network-error: ${(err as Error).message}`,
    };
  }

  if (!res.ok) {
    return {
      verified: false,
      platform: 'devto',
      reason: `devto-http-${res.status}`,
    };
  }

  let body: DevtoArticleResponse;
  try {
    body = (await res.json()) as DevtoArticleResponse;
  } catch (err) {
    return {
      verified: false,
      platform: 'devto',
      reason: `devto-parse-error: ${(err as Error).message}`,
    };
  }

  if (body.type_of !== 'article' || !body.published_at) {
    return {
      verified: false,
      platform: 'devto',
      reason: `devto-not-published (type_of=${body.type_of ?? 'unknown'})`,
    };
  }

  return { verified: true, platform: 'devto', url: body.url ?? '' };
}
