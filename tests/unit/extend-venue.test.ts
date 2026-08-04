/**
 * OPS-VENUE-DAY30-DECISION-W1 / CH4 — extend-venue.ts.
 *
 * The primitive that did not exist. Mocks venue-store + computeVenueStats
 * exactly like promote-venue.test.ts (no DB).
 *
 * The invariant under test above all others: an extension moves
 * `review_deadline_at` and NEVER `seeding_started_at`. Before this wave the
 * only thing resembling an extension was `resetSeedingStarted()`, which
 * restarts the measurement floor — on WEEX that would have discarded 3,412
 * accrued BUY/SELL samples at a 95.15% PFE WR.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/venue-store.js', () => ({
  getVenue: vi.fn(),
  setReviewDeadline: vi.fn(),
  MAX_EXTENSION_COUNT: 2,
}));
vi.mock('../../src/scripts/evaluate-venues.js', () => ({
  computeVenueStats: vi.fn(),
  formatOperatorExtensionNote: (when: Date, days: number, reason?: string) =>
    ` | operator-extended ${when.toISOString()} +${days}d${reason ? ` — ${reason}` : ''}`,
}));

import {
  extendVenue,
  parseDays,
  EXIT_PASS,
  EXIT_FAIL,
  EXIT_INDETERMINATE,
  MAX_EXTENSION_DAYS,
} from '../../src/scripts/extend-venue.js';
import { getVenue, setReviewDeadline } from '../../src/lib/venue-store.js';
import { computeVenueStats } from '../../src/scripts/evaluate-venues.js';
import type { VenueRecord } from '../../src/types.js';

const mockGet = vi.mocked(getVenue);
const mockSet = vi.mocked(setReviewDeadline);
const mockStats = vi.mocked(computeVenueStats);

const NOW = new Date('2026-08-03T09:00:00.000Z');
const SEEDING = '2026-06-11T02:00:00Z';

/** WEEX's real live shape: 3412/7230 over 53 days ⇒ 64.4/day ⇒ 60d to target. */
function weex(o: Partial<VenueRecord> = {}): VenueRecord {
  return {
    exchange_id: 'WEEX', status: 'shadow', asset_count: 723, min_buy_sell_sample: 7230,
    integrated_at: '2026-05-20T15:21:27Z', promoted_at: null, retired_at: null,
    extension_count: 1, last_eval_at: null, last_eval_pfe_wr: 0.9515,
    last_eval_buy_sell_count: 3412, seeding_started_at: SEEDING,
    review_deadline_at: null, notes: 'PILOT-ADAPTERS-W3B C1', ...o,
  };
}
const liveStats = (o = {}) => ({ pfe_wr: 0.9515, buy_sell_count: 3412, days_since: 53, ...o });

/** getVenue is called twice: before the write, and for post-flip verification. */
function withPersist(before: VenueRecord, deadlineDays: number, after: Partial<VenueRecord> = {}) {
  mockGet.mockResolvedValueOnce(before);
  mockGet.mockResolvedValueOnce({
    ...before,
    review_deadline_at: new Date(NOW.getTime() + deadlineDays * 86_400_000).toISOString(),
    extension_count: Math.min(before.extension_count + 1, 2),
    ...after,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mockStats.mockResolvedValue(liveStats());
});

describe('CH4 — strict-decimal --days parse (default-deny BEFORE Number())', () => {
  it('accepts plain positive integers', () => {
    for (const s of ['1', '7', '75', '365']) expect(parseDays(s)).toBe(Number(s));
  });

  it('rejects the values that silently coerce to finite numbers', () => {
    // parseFloat('0x1') -> 0 and Number('0x1') -> 1; both pass isFinite.
    for (const s of ['0x10', '0x1', '1e3', '1.5', '-1', '0', '', ' ', 'abc', 'Infinity', 'NaN', '+7', '007x']) {
      expect(parseDays(s), `expected ${JSON.stringify(s)} to be rejected`).toBeNull();
    }
  });

  it('rejects undefined (flag omitted entirely)', () => {
    expect(parseDays(undefined)).toBeNull();
  });

  it(`rejects beyond the ${MAX_EXTENSION_DAYS}-day ceiling`, () => {
    expect(parseDays(String(MAX_EXTENSION_DAYS))).toBe(MAX_EXTENSION_DAYS);
    expect(parseDays(String(MAX_EXTENSION_DAYS + 1))).toBeNull();
    expect(parseDays('9999')).toBeNull();
  });

  it('extendVenue itself default-denies a bad days value, with NO DB read', async () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, 1e6]) {
      vi.clearAllMocks();
      expect(await extendVenue('WEEX', { days: bad, now: NOW })).toBe(EXIT_FAIL);
      expect(mockSet).not.toHaveBeenCalled();
      expect(mockGet).not.toHaveBeenCalled();
    }
  });
});

describe('CH4 — refusals never write', () => {
  it('unknown venue → FAIL, no write', async () => {
    mockGet.mockResolvedValueOnce(null);
    expect(await extendVenue('NOPE', { days: 75, now: NOW })).toBe(EXIT_FAIL);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it.each(['promoted', 'retired'] as const)('a %s venue → FAIL, no write', async (status) => {
    mockGet.mockResolvedValueOnce(weex({ status }));
    expect(await extendVenue('WEEX', { days: 75, now: NOW })).toBe(EXIT_FAIL);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('UNREACHABLE target without --force → FAIL and the row is untouched', async () => {
    // 3818 remaining at 64.4/day needs ~60d. 30 cannot reach it.
    mockGet.mockResolvedValueOnce(weex());
    expect(await extendVenue('WEEX', { days: 30, now: NOW })).toBe(EXIT_FAIL);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('...and says HOW MANY days would work, plus the projected date', async () => {
    mockGet.mockResolvedValueOnce(weex());
    const errs: string[] = [];
    vi.mocked(console.error).mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
    await extendVenue('WEEX', { days: 30, now: NOW });
    const all = errs.join('\n');
    expect(all).toMatch(/REFUSED/);
    expect(all).toMatch(/64\.\d\d\/day/);
    expect(all).toMatch(/--days 60/);        // ceil(3818 / 64.377)
    expect(all).toMatch(/2026-10-02/);       // NOW + 60d
  });

  it('already at the sample target → FAIL (promote it, do not extend it)', async () => {
    mockGet.mockResolvedValueOnce(weex());
    mockStats.mockResolvedValue(liveStats({ buy_sell_count: 7230 }));
    expect(await extendVenue('WEEX', { days: 75, now: NOW })).toBe(EXIT_FAIL);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('zero accrual → FAIL rather than projecting a divide-by-zero date', async () => {
    mockGet.mockResolvedValueOnce(weex());
    mockStats.mockResolvedValue(liveStats({ buy_sell_count: 0 }));
    expect(await extendVenue('WEEX', { days: 75, now: NOW })).toBe(EXIT_FAIL);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('CH4 — the happy path', () => {
  it('reachable target → deadline set, budget +1, seeding_started_at UNCHANGED', async () => {
    withPersist(weex(), 75);
    expect(await extendVenue('WEEX', { days: 75, reason: 'sample-bound only', now: NOW })).toBe(EXIT_PASS);

    expect(mockSet).toHaveBeenCalledTimes(1);
    const [id, deadline, opts] = mockSet.mock.calls[0];
    expect(id).toBe('WEEX');
    expect((deadline as Date).toISOString()).toBe(new Date(NOW.getTime() + 75 * 86_400_000).toISOString());
    expect(opts?.extensionCount).toBe(2);
    expect(opts?.note).toContain('operator-extended');
    expect(opts?.note).toContain('+75d');
    expect(opts?.note).toContain('sample-bound only');
  });

  it('NEVER touches seeding_started_at — refuses PASS if it moved', async () => {
    // Post-flip verification must catch a mutated measurement floor.
    mockGet.mockResolvedValueOnce(weex());
    mockGet.mockResolvedValueOnce(weex({
      review_deadline_at: new Date(NOW.getTime() + 75 * 86_400_000).toISOString(),
      extension_count: 2,
      seeding_started_at: '2026-08-03T09:00:00.000Z', // the resetSeedingStarted disaster
    }));
    expect(await extendVenue('WEEX', { days: 75, now: NOW })).toBe(EXIT_FAIL);
  });

  it('FAILs when the deadline did not persist', async () => {
    mockGet.mockResolvedValueOnce(weex());
    mockGet.mockResolvedValueOnce(weex({ review_deadline_at: null }));
    expect(await extendVenue('WEEX', { days: 75, now: NOW })).toBe(EXIT_FAIL);
  });

  it('FAILs when the status drifted off shadow during the write', async () => {
    mockGet.mockResolvedValueOnce(weex());
    mockGet.mockResolvedValueOnce(weex({
      review_deadline_at: new Date(NOW.getTime() + 75 * 86_400_000).toISOString(),
      extension_count: 2, status: 'retired',
    }));
    expect(await extendVenue('WEEX', { days: 75, now: NOW })).toBe(EXIT_FAIL);
  });

  it('INDETERMINATE (3) when the venue vanished mid-write — fail-closed, not a pass', async () => {
    mockGet.mockResolvedValueOnce(weex());
    mockGet.mockResolvedValueOnce(null);
    expect(await extendVenue('WEEX', { days: 75, now: NOW })).toBe(EXIT_INDETERMINATE);
  });

  it('is idempotent — a re-run does not double-bump past the CHECK bound', async () => {
    withPersist(weex({ extension_count: 1 }), 75);
    await extendVenue('WEEX', { days: 75, now: NOW });
    expect(mockSet.mock.calls[0][2]?.extensionCount).toBe(2);

    // Second run: budget now spent, so it refuses rather than writing 3.
    vi.clearAllMocks();
    mockStats.mockResolvedValue(liveStats());
    mockGet.mockResolvedValueOnce(weex({ extension_count: 2 }));
    expect(await extendVenue('WEEX', { days: 75, now: NOW })).toBe(EXIT_FAIL);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('CH4 — the extension budget is bounded IN CODE, never by the DB CHECK alone', () => {
  it('at the bound without --force → refuses and names the two real options', async () => {
    mockGet.mockResolvedValueOnce(weex({ extension_count: 2 }));
    const errs: string[] = [];
    vi.mocked(console.error).mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
    expect(await extendVenue('WEEX', { days: 75, now: NOW })).toBe(EXIT_FAIL);
    const all = errs.join('\n');
    expect(all).toContain('promote-venue.js WEEX');
    expect(all).toContain('retire-venue.js WEEX');
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('at the bound WITH --force → moves the deadline but NEVER writes 3', async () => {
    withPersist(weex({ extension_count: 2 }), 75, { extension_count: 2 });
    expect(await extendVenue('WEEX', { days: 75, force: true, now: NOW })).toBe(EXIT_PASS);
    // No count is written at all — writing 2 back would be a no-op dressed up
    // as an increment, and writing 3 would violate the schema CHECK.
    expect(mockSet.mock.calls[0][2]?.extensionCount).toBeUndefined();
  });

  it('no call site ever asks for more than MAX_EXTENSION_COUNT', async () => {
    for (const start of [0, 1, 2]) {
      vi.clearAllMocks();
      mockStats.mockResolvedValue(liveStats());
      withPersist(weex({ extension_count: start }), 75, { extension_count: Math.min(start + 1, 2) });
      await extendVenue('WEEX', { days: 75, force: true, now: NOW });
      const asked = mockSet.mock.calls[0]?.[2]?.extensionCount;
      if (asked !== undefined) expect(asked).toBeLessThanOrEqual(2);
    }
  });
});

describe('CH4 — --force on an unreachable window', () => {
  it('proceeds, but says loudly that the target is unreachable', async () => {
    withPersist(weex(), 30);
    const warns: string[] = [];
    vi.mocked(console.warn).mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')); });
    expect(await extendVenue('WEEX', { days: 30, force: true, now: NOW })).toBe(EXIT_PASS);
    expect(warns.join('\n')).toMatch(/NOT reachable|review checkpoint/);
    expect(mockSet).toHaveBeenCalledTimes(1);
  });
});

describe('CH4 — verdict token (fail-closed, INDETERMINATE = 3)', () => {
  it('emits exactly one token line per run, and it matches the exit code', async () => {
    const cases: [() => void, number, string][] = [
      [() => { withPersist(weex(), 75); }, EXIT_PASS, 'PASS'],
      [() => { mockGet.mockResolvedValueOnce(null); }, EXIT_FAIL, 'FAIL'],
      [() => { mockGet.mockResolvedValueOnce(weex()); mockGet.mockResolvedValueOnce(null); }, EXIT_INDETERMINATE, 'INDETERMINATE'],
    ];
    for (const [setup, expectedCode, expectedToken] of cases) {
      vi.clearAllMocks();
      mockStats.mockResolvedValue(liveStats());
      const logs: string[] = [];
      vi.mocked(console.log).mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
      setup();
      const code = await extendVenue('WEEX', { days: 75, now: NOW });
      const tokens = logs.filter(l => l.startsWith('EXTEND_VENUE_VERDICT='));
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toBe(`EXTEND_VENUE_VERDICT=${expectedToken}`);
      expect(code).toBe(expectedCode);
    }
  });

  it('INDETERMINATE is 3, and is NOT 0 — a fail-open would be indistinguishable from a pass', () => {
    expect(EXIT_INDETERMINATE).toBe(3);
    expect(EXIT_PASS).toBe(0);
    expect(EXIT_FAIL).toBe(1);
  });
});
