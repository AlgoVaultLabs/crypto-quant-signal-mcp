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
      // markRecovered(platform, post_id)
      const platform = params[0] as string;
      const postId = params[1] as string;
      for (const row of store.failures) {
        if (row.platform === platform && row.post_id === postId && row.recovered === 0) {
          row.recovered = 1;
          row.recovered_at = new Date().toISOString();
        }
      }
      return;
    }
  }),
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/SELECT COUNT\(\*\)[\s\S]*FROM forum_post_failures/i.test(sql)) {
      // countRecentFailures — our mock ignores the time window and just
      // counts all rows for the platform (sufficient for a round-trip
      // smoke test — deeper clock math is tested via the prod backend).
      const platform = params[0] as string;
      const n = store.failures.filter((r) => r.platform === platform).length;
      return [{ n }];
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
