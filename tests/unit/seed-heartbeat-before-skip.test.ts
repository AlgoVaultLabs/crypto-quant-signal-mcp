/**
 * OPS-SEED-TF-SKIP-STRAND-HOTFIX-W1 (R2) — regression guard for the H2 fix.
 *
 * `runVenueSeed` must stamp the attempt-recency heartbeat BEFORE the faithful-skip guard, so a legitimately
 * skipped (venue,tf) still records liveness. Without this ordering, a venue whose only fast lines are skipped
 * (WhiteBIT 3m/5m→15m) has a thin 15m liveness floor that a deploy-churn gap false-pages — the exact incident
 * this hotfix fixed. This test FAILS on the pre-hotfix ordering (guard before stamp): a skipped venue would
 * return before `recordSeedHeartbeat`, so the mock would never be called.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { recordSeedHeartbeat } = vi.hoisted(() => ({
  recordSeedHeartbeat: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/lib/seed-heartbeats.js', () => ({ recordSeedHeartbeat }));

import { runVenueSeed } from '../../src/scripts/seed-signals.js';

beforeEach(() => { recordSeedHeartbeat.mockClear(); });

describe('runVenueSeed — attempt heartbeat stamped BEFORE the faithful-skip guard (H2 fix)', () => {
  it('a faithfully-SKIPPED (venue,tf) still stamps the attempt heartbeat and does zero seed work', async () => {
    // WhiteBIT 5m is genuinely unfaithful (→15m) so the guard skips it. The heartbeat must fire regardless —
    // that is what keeps WhiteBIT on a ~3m liveness cadence instead of a false-pageable 15m floor.
    const res = await runVenueSeed('WHITEBIT', {
      timeframe: '5m', top: 10, idempotencyWindow: 0, restrictedCoins: null,
    });
    expect(recordSeedHeartbeat).toHaveBeenCalledWith('WHITEBIT', '5m'); // liveness stamped despite the skip
    expect(res.seeded).toBe(0);     // no seed WORK done
    expect(res.failed).toBe(false); // a by-design skip is not a failure
  });
});

describe('runVenueSeed — a timeframe the adapter does not map is skipped by the guard, not the error path (OPS-SERVED-CANDLE-TRUTH-W1 CH2)', () => {
  it.each(['OKX', 'BYBIT'] as const)('%s 8h: one counted "unserved" skip line, no seed work, no error', async (venue) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await runVenueSeed(venue, { timeframe: '8h', top: 10, idempotencyWindow: 0, restrictedCoins: null });
      expect(res).toMatchObject({ venueId: venue, seeded: 0, skipped: 0, errors: 0, failed: false });
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.includes(`[${venue}] tf=8h SKIP — unserved (${venue} does not serve 8h); not seeded.`))).toHaveLength(1);
      expect(lines.some((l) => l.includes('unfaithful'))).toBe(false);
      expect(err).not.toHaveBeenCalled();
      expect(recordSeedHeartbeat).toHaveBeenCalledWith(venue, '8h');
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});
