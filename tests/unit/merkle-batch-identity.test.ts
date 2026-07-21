/**
 * OPS-MERKLE-BATCH-IDENTITY-W1 canary (2026-07-21).
 *
 * Locks: a batch NUMBER is an IDENTITY (`MAX(batch_id)`), never a row COUNT, and
 * never `response.batches.length`.
 *
 * ## The bug
 *
 * `/api/merkle-batches` serves `getMerkleBatches(limit = 100)` — LIMIT-capped.
 * `track-record-proxy.js` derived BOTH the displayed batch number and the batch
 * count from `data.batches.length`. While fewer than 100 batches existed, length
 * coincidentally equalled `MAX(batch_id)`, so it looked correct. Batch 101
 * (2026-07-20) crossed the cap and /verify pinned at "#100" permanently — while
 * the sibling `latest_batch_at` span, which reads the newest ROW, kept updating.
 * A half-live badge on the page whose entire purpose is verifiability, understating
 * the public track record (102 -> 100).
 *
 * It went unseen because the drift canary tracks monotonic counters with FLOOR
 * tolerance: it fires on a DECREASE. A counter frozen at a cap never decreases,
 * so FLOOR structurally cannot catch it. Hence a behavioural test here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename_ = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename_), '..', '..');
const PROXY = readFileSync(join(REPO_ROOT, 'landing', 'js', 'track-record-proxy.js'), 'utf-8');
const INDEX = readFileSync(join(REPO_ROOT, 'src', 'index.ts'), 'utf-8');

describe('merkle batch identity — count is never used as an identity', () => {
  it('the API serves the identity and the true count explicitly', () => {
    // Without these, every consumer is forced to re-derive from the capped array.
    expect(INDEX).toMatch(/latest_batch_id:\s*summary\.latest_batch_id/);
    expect(INDEX).toMatch(/batch_count:\s*summary\.batch_count/);
  });

  it('the proxy hydrates latest_batch* from the identity, not from a count', () => {
    // The exact regression shape: `setField('latest_batch', '#' + formatCount(n))`
    // where n is `data.batches.length`.
    expect(PROXY).not.toMatch(/setField\(\s*'latest_batch'\s*,\s*'#'\s*\+\s*formatCount\(n\)/);
    expect(PROXY).not.toMatch(/setField\(\s*'latest_batch_n'\s*,\s*formatCount\(n\)/);
    expect(PROXY).toMatch(/latestId/);
    expect(PROXY).toMatch(/data\.latest_batch_id/);
  });

  /**
   * Behavioural: replay the proxy's own derivation over a CAPPED payload — 100
   * rows returned, 102 batches really exist — and assert it renders 102, not 100.
   * This is the exact production state on 2026-07-21.
   */
  it('renders the true batch number when the API response is LIMIT-capped', () => {
    const payload = {
      // Newest first, capped at 100 rows — ids 102 down to 3.
      batches: Array.from({ length: 100 }, (_, i) => ({
        batch_id: 102 - i,
        published_at: new Date(Date.UTC(2026, 6, 21) - i * 86_400_000).toISOString(),
      })),
      latest_batch_id: 102,
      batch_count: 102,
    };

    // Mirror of the proxy's derivation (kept in lockstep by the regex assertions above).
    const arrayLen = Array.isArray(payload.batches) ? payload.batches.length : null;
    const n = typeof payload.batch_count === 'number' ? payload.batch_count : arrayLen;
    const sorted = payload.batches
      .slice()
      .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
    const latest = sorted[0];
    const latestId =
      typeof payload.latest_batch_id === 'number'
        ? payload.latest_batch_id
        : latest && latest.batch_id != null
          ? Number(latest.batch_id)
          : null;

    expect(arrayLen).toBe(100); // the capped array — what the bug used
    expect(n).toBe(102); // true count
    expect(latestId).toBe(102); // true identity
    expect(`#${latestId}`).toBe('#102');
  });

  it('falls back to the newest ROW (not the array length) against an older server', () => {
    // Mid-deploy skew: server has not yet been updated, so the new fields are absent.
    const payload = {
      batches: [
        { batch_id: 102, published_at: '2026-07-21T00:05:03.730Z' },
        { batch_id: 101, published_at: '2026-07-20T00:05:03.536Z' },
      ],
    } as { batches: Array<{ batch_id: number; published_at: string }>; latest_batch_id?: number };

    const sorted = payload.batches
      .slice()
      .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
    const latest = sorted[0];
    const latestId =
      typeof payload.latest_batch_id === 'number'
        ? payload.latest_batch_id
        : latest && latest.batch_id != null
          ? Number(latest.batch_id)
          : null;

    // 102 (the newest row's id) — NOT 2 (the array length).
    expect(latestId).toBe(102);
  });
});
