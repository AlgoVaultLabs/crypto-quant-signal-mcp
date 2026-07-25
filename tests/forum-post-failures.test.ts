import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock performance-db with a tiny in-memory KV that mimics the three
// generic helpers. The forum-post-failures module never reaches the
// real SQLite / PG backend — it just calls dbExec / dbRun / dbQuery.
//
// This is the same mocking pattern tests/get-trade-signal.test.ts uses,
// extended for the three helpers we care about here.

interface MockRow {
  id: number;
  detected_at: string;
  platform: string;
  post_type: string;
  post_id: string | null;
  post_url: string | null;
  failure_reason: string;
  recovered: number;
  recovered_at: string | null;
}

interface MockAuditRow {
  id: number;
  published_at: string;
  platform: string;
  post_type: string;
  post_id: string;
  post_url: string | null;
  verified_at_publish: number;
  verify_failure_reason: string | null;
}

const store: { failures: MockRow[]; audit: MockAuditRow[]; nextId: number } = {
  failures: [],
  audit: [],
  nextId: 1,
};

vi.mock('../src/lib/performance-db.js', () => ({
  dbExec: vi.fn(),
  dbRun: vi.fn((sql: string, ...params: unknown[]) => {
    if (/INSERT INTO forum_post_failures/i.test(sql)) {
      store.failures.push({
        id: store.nextId++,
        detected_at: new Date().toISOString(),
        platform: params[0] as string,
        post_type: params[1] as string,
        post_id: (params[2] as string | null) ?? null,
        post_url: (params[3] as string | null) ?? null,
        failure_reason: params[4] as string,
        recovered: 0,
        recovered_at: null,
      });
      return;
    }
    if (/INSERT INTO forum_post_audit_log/i.test(sql)) {
      store.audit.push({
        id: store.nextId++,
        published_at: new Date().toISOString(),
        platform: params[0] as string,
        post_type: params[1] as string,
        post_id: params[2] as string,
        post_url: (params[3] as string | null) ?? null,
        verified_at_publish: params[4] ? 1 : 0,
        verify_failure_reason: (params[5] as string | null) ?? null,
      });
      return;
    }
    if (/UPDATE forum_post_failures/i.test(sql)) {
      // markRecovered(platform, post_id) clears ALL unrecovered rows for the
      // post; clearIndeterminate adds a `failure_reason LIKE ?` param and clears
      // ONLY the indeterminate markers (leaving confirmed drift rows alone).
      const platform = params[0] as string;
      const postId = params[1] as string;
      const likeParam = params[2] as string | undefined;
      const prefix = likeParam != null ? String(likeParam).replace(/%$/, '') : null;
      for (const row of store.failures) {
        if (row.platform === platform && row.post_id === postId && row.recovered === 0) {
          if (prefix != null && /like/i.test(sql) && !row.failure_reason.startsWith(prefix)) continue;
          row.recovered = 1;
          row.recovered_at = new Date().toISOString();
        }
      }
      return;
    }
  }),
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/SELECT COUNT\(\*\)[\s\S]*FROM forum_post_failures/i.test(sql)) {
      // Predicate-aware count. countRecentFailures ignores the time window and
      // counts by platform; the per-post variants (hasUnrecoveredFailure /
      // countUnrecoveredIndeterminate) honour post_id + recovered + the
      // indeterminate-prefix LIKE / NOT LIKE, so the backstop logic is real-tested.
      const platform = params[0] as string;
      let rows = store.failures.filter((r) => r.platform === platform);
      if (/post_id\s*=\s*\?/i.test(sql)) {
        const postId = params[1] as string;
        rows = rows.filter((r) => r.post_id === postId);
        if (/recovered\s*=\s*(false|0)/i.test(sql)) {
          rows = rows.filter((r) => r.recovered === 0);
        }
        const likeParam = params[2] as string | undefined;
        if (likeParam != null) {
          const prefix = String(likeParam).replace(/%$/, '');
          rows = /not\s+like/i.test(sql)
            ? rows.filter((r) => !r.failure_reason.startsWith(prefix))
            : rows.filter((r) => r.failure_reason.startsWith(prefix));
        }
      }
      return [{ n: rows.length }];
    }
    if (/SELECT [\s\S]*FROM forum_post_audit_log/i.test(sql)) {
      const platform = params[0] as string;
      const limit = Number(params[2] ?? 100);
      return store.audit
        .filter((r) => r.platform === platform)
        .slice(-limit)
        .reverse()
        .map((r) => ({
          post_id: r.post_id,
          post_url: r.post_url,
          published_at: r.published_at,
          post_type: r.post_type,
        }));
    }
    return [];
  }),
}));

import {
  recordFailure,
  countRecentFailures,
  markRecovered,
  recordPublished,
  getRecentPublished,
  hasUnrecoveredFailure,
  countUnrecoveredIndeterminate,
  clearIndeterminate,
  INDETERMINATE_REASON_PREFIX,
  __resetInitForTests,
} from '../src/lib/forum-post-failures.js';

describe('forum-post-failures', () => {
  beforeEach(() => {
    store.failures = [];
    store.audit = [];
    store.nextId = 1;
    __resetInitForTests();
  });

  it('recordFailure + countRecentFailures round-trip', async () => {
    expect(await countRecentFailures('hashnode', 24)).toBe(0);

    await recordFailure('hashnode', 'track-record', 'hashnode-null-on-requery', 'post-1', 'https://example.test/post-1');
    await recordFailure('hashnode', 'release', 'hashnode-http-503', 'post-2');
    await recordFailure('moltbook', 'track-record', 'moltbook-is_spam', 'mb-1');

    expect(await countRecentFailures('hashnode', 24)).toBe(2);
    expect(await countRecentFailures('moltbook', 24)).toBe(1);
    expect(await countRecentFailures('devto', 24)).toBe(0);
  });

  it('markRecovered flips the row and leaves unrelated rows alone', async () => {
    await recordFailure('hashnode', 'track-record', 'hashnode-null-on-requery', 'post-1');
    await recordFailure('hashnode', 'release', 'hashnode-http-503', 'post-2');

    await markRecovered('hashnode', 'post-1');

    expect(store.failures.find((r) => r.post_id === 'post-1')?.recovered).toBe(1);
    expect(store.failures.find((r) => r.post_id === 'post-2')?.recovered).toBe(0);
  });

  it('recordPublished + getRecentPublished round-trip', async () => {
    await recordPublished('hashnode', 'track-record', 'hn-1', 'https://algovault.hashnode.dev/hn-1', true);
    await recordPublished('hashnode', 'release', 'hn-2', 'https://algovault.hashnode.dev/hn-2', false, 'dropped-at-publish');
    await recordPublished('devto', 'track-record', '1234', 'https://dev.to/algovaultlabs/x', true);

    const rows = await getRecentPublished('hashnode', 7, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0].post_id).toBe('hn-2'); // newest first
    expect(rows[1].post_id).toBe('hn-1');

    const devtoRows = await getRecentPublished('devto', 7, 10);
    expect(devtoRows).toHaveLength(1);
    expect(devtoRows[0].post_id).toBe('1234');
  });
});

/**
 * OPS-MONITOR-TRANSIENT-CLASSIFY-W1 — the forum self-audit sustained-indeterminate
 * backstop. A transient verify failure (HTTP 429 / 5xx / network) is recorded
 * with the INDETERMINATE_REASON_PREFIX so it (a) is NOT counted as drift, (b) does
 * NOT mark the post "known broken" (so it is re-verified next audit), and (c)
 * escalates only after a sustained streak with honest framing.
 */
describe('forum-post-failures — indeterminate (transient) backstop', () => {
  beforeEach(() => {
    store.failures = [];
    store.audit = [];
    store.nextId = 1;
    __resetInitForTests();
  });

  it('countUnrecoveredIndeterminate counts only unrecovered indeterminate markers for the post', async () => {
    // The real 2026-07-24 case: dev.to post 4223682 came back http-429.
    await recordFailure('devto', 'market-insight', `${INDETERMINATE_REASON_PREFIX}devto-http-429`, '4223682');
    expect(await countUnrecoveredIndeterminate('devto', '4223682')).toBe(1);

    // A second daily audit still transient → the streak grows.
    await recordFailure('devto', 'market-insight', `${INDETERMINATE_REASON_PREFIX}devto-http-429`, '4223682');
    expect(await countUnrecoveredIndeterminate('devto', '4223682')).toBe(2);

    // A CONFIRMED drift row for the same post is NOT an indeterminate marker.
    await recordFailure('devto', 'market-insight', 'drift-detected-on-self-audit: devto-not-published', '4223682');
    expect(await countUnrecoveredIndeterminate('devto', '4223682')).toBe(2);

    // Other posts are independent.
    expect(await countUnrecoveredIndeterminate('devto', '9999999')).toBe(0);
  });

  it('clearIndeterminate resets the streak (verify recovered) but leaves drift + other posts alone', async () => {
    await recordFailure('devto', 'market-insight', `${INDETERMINATE_REASON_PREFIX}devto-http-429`, '4223682');
    await recordFailure('devto', 'market-insight', 'drift-detected-on-self-audit: devto-not-published', '4223682');
    await recordFailure('devto', 'market-insight', `${INDETERMINATE_REASON_PREFIX}devto-http-503`, 'other-post');

    await clearIndeterminate('devto', '4223682');

    expect(await countUnrecoveredIndeterminate('devto', '4223682')).toBe(0); // streak reset
    // The confirmed drift row for that post is untouched.
    const drift = store.failures.find(
      (r) => r.post_id === '4223682' && r.failure_reason.startsWith('drift-detected'),
    );
    expect(drift?.recovered).toBe(0);
    // A different post's indeterminate marker is untouched.
    expect(await countUnrecoveredIndeterminate('devto', 'other-post')).toBe(1);
  });

  it('hasUnrecoveredFailure IGNORES indeterminate markers (transient ⇒ re-verify next audit, not "known broken")', async () => {
    await recordFailure('devto', 'market-insight', `${INDETERMINATE_REASON_PREFIX}devto-http-429`, '4223682');
    expect(await hasUnrecoveredFailure('devto', '4223682')).toBe(false);
  });

  it('hasUnrecoveredFailure still returns true for a real (confirmed) drift failure', async () => {
    await recordFailure('devto', 'market-insight', 'drift-detected-on-self-audit: devto-not-published', '5555555');
    expect(await hasUnrecoveredFailure('devto', '5555555')).toBe(true);
  });
});
