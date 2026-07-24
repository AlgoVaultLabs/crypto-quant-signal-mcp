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
