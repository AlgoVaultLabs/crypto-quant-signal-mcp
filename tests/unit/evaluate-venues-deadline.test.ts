/**
 * OPS-VENUE-DAY30-DECISION-W1 / CH2 — Branch 3 becomes deadline-gated.
 *
 * THE DEFECT: Branch 3's predicate was `days_since >= DAY_30_FLOOR &&
 * venue.extension_count >= 1`. Nothing could falsify it — bumping
 * extension_count 1 → 2 leaves it TRUE, and the only clock counts up — so a
 * venue reaching day-30 re-fired `manual_required` EVERY SINGLE DAY. Measured
 * before this fix: 33 consecutive daily fires, 2026-07-02 → 2026-08-03.
 *
 * Every branch is pinned in BOTH directions, including the ones this chapter
 * must NOT change (Branch 0/1/2 and the ordering between them).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/performance-db.js', () => ({ dbQuery: vi.fn() }));
vi.mock('../../src/lib/venue-store.js', () => ({
  listVenues: vi.fn(),
  recordEval: vi.fn(),
  setStatus: vi.fn(),
  incrementExtension: vi.fn(),
  setReviewDeadline: vi.fn(),
}));
vi.mock('../../src/lib/telegram.js', () => ({
  sendVenueStatusChange: vi.fn().mockResolvedValue(true),
}));

import {
  decide,
  evaluateAllShadowVenues,
  countAutoDeferrals,
  formatAutoDeferralNote,
  formatOperatorExtensionNote,
  AUTO_DEFERRAL_DAYS,
  DEFERRAL_ESCALATION_THRESHOLD,
} from '../../src/scripts/evaluate-venues.js';
import { dbQuery } from '../../src/lib/performance-db.js';
import { listVenues, recordEval, incrementExtension, setReviewDeadline } from '../../src/lib/venue-store.js';
import { sendVenueStatusChange } from '../../src/lib/telegram.js';
import type { VenueRecord } from '../../src/types.js';

const mockQuery = vi.mocked(dbQuery);
const mockList = vi.mocked(listVenues);
const mockSetDeadline = vi.mocked(setReviewDeadline);
const mockSend = vi.mocked(sendVenueStatusChange);
const mockIncrement = vi.mocked(incrementExtension);

const NOW = new Date('2026-08-03T06:00:00.000Z');
const DAY = 86_400_000;

/** WEEX's real live shape at wave time: day 53, ext 1, 3412/7230, 95.15% WR. */
function venue(overrides: Partial<VenueRecord> = {}): VenueRecord {
  return {
    exchange_id: 'WEEX', status: 'shadow', asset_count: 723, min_buy_sell_sample: 7230,
    integrated_at: '2026-05-20T15:21:27Z', promoted_at: null, retired_at: null,
    extension_count: 1, last_eval_at: null, last_eval_pfe_wr: 0.9515,
    last_eval_buy_sell_count: 3412, seeding_started_at: '2026-06-11T02:00:00Z',
    review_deadline_at: null, notes: null, ...overrides,
  };
}
const stats = (o: Partial<{ pfe_wr: number | null; buy_sell_count: number; days_since: number }> = {}) =>
  ({ pfe_wr: 0.9515, buy_sell_count: 3412, days_since: 53, ...o });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mockQuery.mockResolvedValue([]);
  mockList.mockResolvedValue([]);
  mockSend.mockResolvedValue(true);
});

describe('CH2 — Branch 3 deadline gate (the 33-day defect)', () => {
  it('day 53, ext 1, deadline null → manual_required (unchanged pre-wave behaviour)', () => {
    const d = decide(venue({ review_deadline_at: null }), stats(), NOW);
    expect(d.action).toBe('manual_required');
  });

  it('day 53, ext 1, deadline now+1d → no_op / manual_review_deferred (NO alert)', () => {
    const d = decide(venue({ review_deadline_at: new Date(NOW.getTime() + DAY).toISOString() }), stats(), NOW);
    expect(d.action).toBe('no_op');
    expect(d).toMatchObject({ reason: 'manual_review_deferred', days_since: 53 });
  });

  it('day 53, ext 1, deadline now-1d (ELAPSED) → manual_required fires again', () => {
    const d = decide(venue({ review_deadline_at: new Date(NOW.getTime() - DAY).toISOString() }), stats(), NOW);
    expect(d.action).toBe('manual_required');
  });

  it('deadline EXACTLY now → manual_required (boundary is `<`, not `<=`)', () => {
    const d = decide(venue({ review_deadline_at: NOW.toISOString() }), stats(), NOW);
    expect(d.action).toBe('manual_required');
    // ...and one millisecond later it defers. Pins which side of the boundary.
    const d2 = decide(venue({ review_deadline_at: new Date(NOW.getTime() + 1).toISOString() }), stats(), NOW);
    expect(d2.action).toBe('no_op');
  });

  it('treats an ABSENT (undefined) deadline like null — `!= null`, not `!== null`', () => {
    const v = venue();
    delete (v as Partial<VenueRecord>).review_deadline_at;
    const d = decide(v, stats(), NOW);
    // `undefined !== null` is true, so a `!== null` check would have sent
    // `new Date(undefined)` (Invalid Date) into the comparison. Fail toward
    // alerting, never toward silence.
    expect(d.action).toBe('manual_required');
  });

  it('an unparseable deadline fails toward ALERTING, never toward silence', () => {
    const d = decide(venue({ review_deadline_at: 'not-a-date' }), stats(), NOW);
    expect(d.action).toBe('manual_required');
  });

  it('decide() defaults `now` when omitted — signature stays back-compatible', () => {
    const far = new Date(Date.now() + 365 * DAY).toISOString();
    expect(decide(venue({ review_deadline_at: far }), stats()).action).toBe('no_op');
  });
});

describe('CH2 — branches this chapter must NOT change', () => {
  it('day 20, ext 0 → extended (Branch 2 unchanged)', () => {
    expect(decide(venue({ extension_count: 0 }), stats({ days_since: 20 }), NOW).action).toBe('extended');
  });

  it('day 20, ext 1, sample short → no_op / sample_insufficient (unchanged)', () => {
    // Days 15–29 with an extension already spent: Branch 2 is skipped
    // (ext !== 0) and Branch 3 needs day-30, so this falls to Branch 4.
    const d = decide(venue({ extension_count: 1 }), stats({ days_since: 20, buy_sell_count: 3412 }), NOW);
    expect(d).toMatchObject({ action: 'no_op', reason: 'sample_insufficient' });
  });

  it('PRE-EXISTING: `already_extended_pre_day_30` is UNREACHABLE — documented, not fixed here', () => {
    // Branch 4's final `else` is reached only when days_since >= DAY_15_FLOOR
    // AND pfe_wr is non-null AND buy_sell_count >= min_buy_sell_sample AND
    // pfe_wr >= PFE_WR_THRESHOLD — which is EXACTLY Branch 1's predicate, and
    // Branch 1 returns first. So no input can produce this reason.
    //
    // Found while pinning the "day 20, ext 1" row of this wave's AC table,
    // which asserted that reason. The spec described a state the code cannot
    // enter. Branch 1 and Branch 4 are both on CH2's must-NOT-write list, so
    // this is RECORDED here rather than fixed — filed as
    // OPS-VENUE-DEAD-EVAL-REASON-W{NEXT}. This test is the tripwire: if a
    // future wave makes the reason reachable, it fails and someone re-reads
    // the decision tree deliberately.
    const qualifying = decide(
      venue({ extension_count: 1 }),
      stats({ days_since: 20, buy_sell_count: 8000, pfe_wr: 0.9515 }),
      NOW,
    );
    expect(qualifying.action).toBe('ready_for_promotion');
    expect(qualifying).not.toMatchObject({ reason: 'already_extended_pre_day_30' });
  });

  it('buy_sell_count === 0 at day 53, ext 1 → Branch 0 STILL pre-empts', () => {
    // The OPS-SHADOW-ALERT-HYGIENE-W1 guarantee: a venue with no pipeline must
    // never fire an operator alert or burn budget on empty data. Branch 0 runs
    // FIRST, so the new deadline gate must not have moved ahead of it.
    const d = decide(venue(), stats({ buy_sell_count: 0 }), NOW);
    expect(d).toMatchObject({ action: 'no_op', reason: 'no_pipeline_yet' });
  });

  it('a QUALIFYING venue past day-30 with a live deadline → ready_for_promotion still WINS', () => {
    // Branch 1 precedes Branch 3. A venue that has earned promotion must not be
    // silently parked by a deferral deadline. Ordering pinned.
    const d = decide(
      venue({ review_deadline_at: new Date(NOW.getTime() + 30 * DAY).toISOString() }),
      stats({ buy_sell_count: 7230, pfe_wr: 0.95, days_since: 53 }),
      NOW,
    );
    expect(d.action).toBe('ready_for_promotion');
  });
});

describe('CH2 — the deferral counter (D-5: one marker shape, no new column)', () => {
  it('counts nothing on null/empty/unrelated notes', () => {
    expect(countAutoDeferrals(null)).toBe(0);
    expect(countAutoDeferrals('')).toBe(0);
    expect(countAutoDeferrals('PILOT-ADAPTERS-W3B C1 (2026-05-20) — WEEX USDT-M Perpetual')).toBe(0);
  });

  it('counts markers it wrote itself (round-trip: format → count)', () => {
    let notes = 'PILOT-ADAPTERS-W3B C1 — WEEX';
    for (let n = 1; n <= 4; n++) {
      notes += formatAutoDeferralNote(new Date(NOW.getTime() + n * 7 * DAY), n);
      expect(countAutoDeferrals(notes)).toBe(n);
    }
  });

  it('RESETS after an operator extension — an extension IS a decision', () => {
    let notes = 'seed';
    notes += formatAutoDeferralNote(NOW, 1);
    notes += formatAutoDeferralNote(NOW, 2);
    expect(countAutoDeferrals(notes)).toBe(2);
    notes += formatOperatorExtensionNote(NOW, 75, 'sample-bound only');
    // Without the reset, the very next auto-deferral would read #3 and escalate
    // immediately after the operator just acted — a false alarm on the one
    // venue whose owner IS paying attention.
    expect(countAutoDeferrals(notes)).toBe(0);
    notes += formatAutoDeferralNote(NOW, 1);
    expect(countAutoDeferrals(notes)).toBe(1);
  });

  it('is not fooled by prose that merely mentions the words', () => {
    expect(countAutoDeferrals('this venue was auto-deferred a few times, roughly (#5) of them')).toBe(0);
  });
});

describe('CH2 — self-throttle write path', () => {
  it('manual_required with no deadline sets now+7d AND appends the marker', async () => {
    mockList.mockImplementation(async (s?: string) => (s === 'shadow' ? [venue()] : []) as VenueRecord[]);
    mockQuery.mockResolvedValue([{ buy_sell_count: 3412, pfe_wr: 0.9515 }]);

    await evaluateAllShadowVenues(NOW);

    expect(mockSetDeadline).toHaveBeenCalledTimes(1);
    const [id, deadline, opts] = mockSetDeadline.mock.calls[0];
    expect(id).toBe('WEEX');
    expect((deadline as Date).toISOString())
      .toBe(new Date(NOW.getTime() + AUTO_DEFERRAL_DAYS * DAY).toISOString());
    expect(opts?.note).toBe(formatAutoDeferralNote(NOW, 1));
    // The throttle must never spend extension budget — that is an operator act.
    expect(opts?.extensionCount).toBeUndefined();
    expect(mockIncrement).not.toHaveBeenCalled();
  });

  it('a DEFERRED venue writes NOTHING and sends NOTHING', async () => {
    const deferred = venue({ review_deadline_at: new Date(NOW.getTime() + 3 * DAY).toISOString() });
    mockList.mockImplementation(async (s?: string) => (s === 'shadow' ? [deferred] : []) as VenueRecord[]);
    mockQuery.mockResolvedValue([{ buy_sell_count: 3412, pfe_wr: 0.9515 }]);

    const summary = await evaluateAllShadowVenues(NOW);

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSetDeadline).not.toHaveBeenCalled();
    expect(mockIncrement).not.toHaveBeenCalled();
    expect(summary.actions[0].decision).toMatchObject({ reason: 'manual_review_deferred' });
  });

  it('carries next_review_at + deferral_count + escalated in the alert payload', async () => {
    mockList.mockImplementation(async (s?: string) => (s === 'shadow' ? [venue()] : []) as VenueRecord[]);
    mockQuery.mockResolvedValue([{ buy_sell_count: 3412, pfe_wr: 0.9515 }]);

    await evaluateAllShadowVenues(NOW);

    expect(mockSend.mock.calls[0][0]).toMatchObject({
      venue: 'WEEX',
      action: 'manual_required',
      next_review_at: new Date(NOW.getTime() + AUTO_DEFERRAL_DAYS * DAY).toISOString(),
      deferral_count: 1,
      escalated: false,
    });
  });

  it(`escalates at the ${DEFERRAL_ESCALATION_THRESHOLD}rd deferral, not before`, async () => {
    const priors = formatAutoDeferralNote(NOW, 1) + formatAutoDeferralNote(NOW, 2);
    mockList.mockImplementation(async (s?: string) =>
      (s === 'shadow' ? [venue({ notes: `seed${priors}` })] : []) as VenueRecord[]);
    mockQuery.mockResolvedValue([{ buy_sell_count: 3412, pfe_wr: 0.9515 }]);

    await evaluateAllShadowVenues(NOW);

    expect(mockSend.mock.calls[0][0]).toMatchObject({ deferral_count: 3, escalated: true });
  });

  it('threads `now` into decide() — an injected clock is honoured end-to-end', async () => {
    // Deadline is in the past relative to NOW but in the future relative to an
    // earlier injected clock. Proves evaluateAllShadowVenues passes `now` down
    // rather than letting decide() fall back to the system clock.
    const v = venue({ review_deadline_at: new Date(NOW.getTime() - DAY).toISOString() });
    mockList.mockImplementation(async (s?: string) => (s === 'shadow' ? [v] : []) as VenueRecord[]);
    mockQuery.mockResolvedValue([{ buy_sell_count: 3412, pfe_wr: 0.9515 }]);

    const earlier = new Date(NOW.getTime() - 3 * DAY);
    const summary = await evaluateAllShadowVenues(earlier);
    expect(summary.actions[0].decision).toMatchObject({ reason: 'manual_review_deferred' });
  });

  it('the day-15 auto-extend path is untouched — still increments, sets no deadline', async () => {
    const v = venue({ extension_count: 0, seeding_started_at: '2026-07-14T00:00:00Z' });
    mockList.mockImplementation(async (s?: string) => (s === 'shadow' ? [v] : []) as VenueRecord[]);
    mockQuery.mockResolvedValue([{ buy_sell_count: 500, pfe_wr: 0.5 }]);

    await evaluateAllShadowVenues(NOW);

    expect(mockIncrement).toHaveBeenCalledWith('WEEX');
    expect(mockSetDeadline).not.toHaveBeenCalled();
    expect(mockSend.mock.calls[0][0]).toMatchObject({ action: 'extended' });
  });
});
