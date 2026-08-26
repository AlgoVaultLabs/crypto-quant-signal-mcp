/**
 * OPS-DIGEST-MERKLE-ANCHOR-W1 — golden tests for the daily digest's
 * "Daily Batches" bullet (the on-chain Base anchor line).
 *
 * Fixtures are the REAL 2026-08-26 production values read from
 * /api/merkle-batches (batch #138, 2,892 calls anchored at 00:05:03.971Z;
 * 138 batches published; 511,746 calls verified) so the golden strings are
 * anchored to a measured response rather than to invented numbers.
 */
import { describe, it, expect } from 'vitest';
import {
  formatMerkleAnchoring,
  MERKLE_ANCHOR_STALE_MS,
  type MerkleAnchorSummary,
} from '../../src/lib/merkle-anchor-format.js';

const LIVE: MerkleAnchorSummary = {
  latest_batch_id: 138,
  batch_count: 138,
  total_signals: 511_746,
  latest_published_at: '2026-08-26T00:05:03.971Z',
  latest_signal_count: 2_892,
};
/** The real digest slot: 08:00 UTC, ~8h after the 00:05 anchor. */
const DIGEST_08Z = Date.parse('2026-08-26T08:00:00.000Z');

describe('formatMerkleAnchoring', () => {
  it('renders the daily anchor and the cumulative pair at the real digest hour', () => {
    expect(formatMerkleAnchoring(LIVE, DIGEST_08Z)).toEqual([
      '• Daily Batches: #138 · 2,892 calls anchored (2026-08-26 00:05 UTC)',
      '  ↳ 🔗 138 published · 511,746 calls verified on Base',
    ]);
  });

  it('renders the SAME cumulative pair the /verify page shows', () => {
    // The public "On-Chain Proof: 138 batches published · 511,746 calls verified"
    // line and this bullet must never disagree — both project batch_count /
    // total_signals from getMerkleBatchSummary(), never from a capped array.
    const [, totals] = formatMerkleAnchoring(LIVE, DIGEST_08Z);
    expect(totals).toContain('138 published');
    expect(totals).toContain('511,746 calls verified');
  });

  it('does NOT flag stale just inside the 26h window', () => {
    const now = Date.parse(LIVE.latest_published_at!) + MERKLE_ANCHOR_STALE_MS - 60_000;
    expect(formatMerkleAnchoring(LIVE, now)[0]).not.toContain('⚠️');
  });

  it('flags a missed daily anchor past the 26h window, with its age', () => {
    const now = Date.parse('2026-08-28T08:05:03.971Z'); // 2d 8h later
    expect(formatMerkleAnchoring(LIVE, now)).toEqual([
      '• Daily Batches: ⚠️ no anchor in 26h — latest #138 · 2,892 calls anchored ' +
        '(2026-08-26 00:05 UTC, 2d 8h ago)',
      '  ↳ 🔗 138 published · 511,746 calls verified on Base',
    ]);
  });

  it('renders hours (not days) for a single missed slot', () => {
    const now = Date.parse('2026-08-27T07:05:03.971Z'); // 31h later
    expect(formatMerkleAnchoring(LIVE, now)[0]).toContain('31h ago');
  });

  it('omits the freshness clause entirely when the timestamp is unknown', () => {
    // An unknown publish time must render as NEITHER fresh nor stale.
    const s = { ...LIVE, latest_published_at: null };
    const out = formatMerkleAnchoring(s, DIGEST_08Z);
    expect(out[0]).toBe('• Daily Batches: #138 · 2,892 calls anchored');
    expect(out[0]).not.toContain('⚠️');
    expect(out[1]).toBe('  ↳ 🔗 138 published · 511,746 calls verified on Base');
  });

  it('omits the anchored-calls clause when the latest signal_count is unknown', () => {
    const s = { ...LIVE, latest_signal_count: null };
    expect(formatMerkleAnchoring(s, DIGEST_08Z)[0]).toBe(
      '• Daily Batches: #138 (2026-08-26 00:05 UTC)',
    );
  });

  it('renders an explicit placeholder for an empty batch table', () => {
    const s: MerkleAnchorSummary = {
      latest_batch_id: null,
      batch_count: 0,
      total_signals: 0,
      latest_published_at: null,
      latest_signal_count: null,
    };
    expect(formatMerkleAnchoring(s, DIGEST_08Z)).toEqual([
      '• Daily Batches: — (none published yet)',
    ]);
  });

  it('renders an explicit placeholder when the summary read failed', () => {
    // The digest passes null when getMerkleBatchSummary() rejects. A dropped
    // line would be indistinguishable from "nothing was anchored".
    expect(formatMerkleAnchoring(null, DIGEST_08Z)).toEqual([
      '• Daily Batches: — (unavailable)',
    ]);
    expect(formatMerkleAnchoring(undefined, DIGEST_08Z)).toEqual([
      '• Daily Batches: — (unavailable)',
    ]);
  });

  it('never returns an empty array, whatever it is handed', () => {
    for (const s of [null, undefined, { ...LIVE, batch_count: 0 }, { ...LIVE, batch_count: NaN }]) {
      expect(formatMerkleAnchoring(s as MerkleAnchorSummary | null, DIGEST_08Z).length)
        .toBeGreaterThan(0);
    }
  });

  it('emits no Telegram-Markdown control characters', () => {
    // post() sends parse_mode=Markdown; an unescaped _ * ` [ would cost the
    // operator the whole digest (or force the plain-text retry).
    for (const line of formatMerkleAnchoring(LIVE, DIGEST_08Z)) {
      expect(line).not.toMatch(/[_*`[\]]/);
    }
  });
});
