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

/**
 * Multi-stage Hashnode verifier — checks at 5s, 60s, and 5min post-publish.
 * Hashnode's anti-spam moderation pipeline runs AFTER the initial publish,
 * sometime between ~30s and ~10min. The single 5s verify is insufficient.
 *
 * Returns the FIRST stage that succeeds with the URL, or the LAST failed
 * stage with the reason and `stage` annotation.
 *
 * Stages:
 *   1. 5s   — initial verify (existing behavior). If post is missing here,
 *             it's a publish failure, not anti-spam.
 *   2. 60s  — anti-spam often fires within the first minute on low-follower
 *             publications.
 *   3. 5min — final confirmation window before declaring the post survived.
 *
 * Implementation: stages are awaited sequentially. Total wall-clock cost
 * is up to ~5 minutes. Callers that cannot block should fire-and-forget
 * via `verifyHashnodePostMultiStageDeferred()` (below).
 */
export async function verifyHashnodePostMultiStage(
  postId: string,
  pat: string,
  pubId: string,
  opts: VerifyOptions = {}
): Promise<VerifyResult & { stage?: '5s' | '60s' | '5min' }> {
  const stages: Array<{ label: '5s' | '60s' | '5min'; delayMs: number }> = [
    { label: '5s', delayMs: opts.delayMs ?? 5000 },
    { label: '60s', delayMs: 55_000 },
    { label: '5min', delayMs: 240_000 },
  ];

  let lastResult: VerifyResult & { stage?: '5s' | '60s' | '5min' } = {
    verified: false,
    platform: 'hashnode',
    reason: 'no-stage-ran',
    stage: '5s',
  };

  for (const stage of stages) {
    const result = await verifyHashnodePost(postId, pat, pubId, {
      ...opts,
      delayMs: stage.delayMs,
    });
    lastResult = { ...result, stage: stage.label };
    if (!result.verified) {
      return {
        verified: false,
        platform: 'hashnode',
        reason: `hashnode-anti-spam-deleted-post-after-${stage.label}: ${result.reason}`,
        stage: stage.label,
      };
    }
  }

  return lastResult;
}

/**
 * Fire-and-forget multi-stage Hashnode verify. Returns immediately after
 * the 5s stage; the 60s + 5min stages run in the background and invoke
 * `onLateResult` with the eventual outcome (used to fire a CRITICAL
 * Telegram alert on silent deletion).
 *
 * The returned promise resolves with the 5s stage's `VerifyResult` so the
 * caller can record the initial publish-time verification synchronously.
 *
 * The background timers keep the Node process alive until they fire so the
 * late checks reliably run in cron context (the cron is invoked 3x/week, an
 * extra ~5min of wall-clock per run is acceptable). Callers in test
 * environments can pass `opts.skipDeferred=true` to suppress the timers.
 */
export function verifyHashnodePostMultiStageDeferred(
  postId: string,
  pat: string,
  pubId: string,
  onLateResult: (
    result: VerifyResult & { stage: '60s' | '5min' }
  ) => void | Promise<void>,
  opts: VerifyOptions & { skipDeferred?: boolean } = {}
): Promise<VerifyResult> {
  const initialDelay = opts.delayMs ?? 5000;
  const initial = verifyHashnodePost(postId, pat, pubId, { ...opts, delayMs: initialDelay });

  if (opts.skipDeferred) return initial;

  // Schedule 60s + 5min checks. Timers are NOT unref()'d so they keep the
  // Node process alive until they fire. The cron is invoked 3x/week and the
  // extra ~5min wall-clock is acceptable.
  const stages: Array<{ label: '60s' | '5min'; delayMs: number }> = [
    { label: '60s', delayMs: 60_000 },
    { label: '5min', delayMs: 300_000 },
  ];

  for (const stage of stages) {
    setTimeout(() => {
      verifyHashnodePost(postId, pat, pubId, { ...opts, delayMs: 0 })
        .then((res) => {
          const annotated: VerifyResult & { stage: '60s' | '5min' } = res.verified
            ? { ...res, stage: stage.label }
            : {
                verified: false,
                platform: 'hashnode',
                reason: `hashnode-anti-spam-deleted-post-after-${stage.label}: ${res.reason}`,
                stage: stage.label,
              };
          return onLateResult(annotated);
        })
        .catch((err) => {
          console.error(
            `[verify-hashnode-deferred] stage=${stage.label} error:`,
            (err as Error).message
          );
        });
    }, stage.delayMs);
  }

  return initial;
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

  // `verification_status: "pending"` is the normal state for a new/unverified
  // Moltbook account. Per 2026-04-17 ground-truth check (post c55fb14e was
  // is_spam:false, verification_status:"pending", AND visible in the aitools
  // feed), pending posts are NOT dropped. Warn but pass.
  if (post.verification_status === 'pending') {
    console.warn(
      `[verify-moltbook] post ${post.id ?? postId} verification_status=pending (normal for new accounts) — passing`
    );
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
