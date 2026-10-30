/**
 * DECISION-CALL-V1-W2 R2 — the pure per-venue cost arithmetic of `pre_trade_check`.
 */
import { describe, it, expect } from 'vitest';
import {
  fundingEventsInHold,
  fundingCostBps,
  entryAfterNextFundingSavingBps,
  topOfBookSpread,
  venueCapacityUsd,
  sideSign,
} from '../../src/lib/pre-trade-costs.js';

const H = 3_600_000;
const NOW = Date.parse('2026-10-30T12:00:00Z');

describe('fundingEventsInHold — the window is (now, now + hold]', () => {
  it('counts exactly from the next funding time', () => {
    expect(fundingEventsInHold({ nextFundingTime: NOW + 4 * H, intervalHours: 8, holdHours: 8, nowMs: NOW }))
      .toEqual({ events: 1, exact: true, nextFundingAt: NOW + 4 * H });
    expect(fundingEventsInHold({ nextFundingTime: NOW + 1 * H, intervalHours: 1, holdHours: 8, nowMs: NOW }).events).toBe(8);
    expect(fundingEventsInHold({ nextFundingTime: NOW + 4 * H, intervalHours: 4, holdHours: 24, nowMs: NOW }).events).toBe(6);
  });
  it('an event AT the exit instant counts; one just past it does not', () => {
    expect(fundingEventsInHold({ nextFundingTime: NOW + 8 * H, intervalHours: 8, holdHours: 8, nowMs: NOW }).events).toBe(1);
    expect(fundingEventsInHold({ nextFundingTime: NOW + 8 * H + 1, intervalHours: 8, holdHours: 8, nowMs: NOW }).events).toBe(0);
  });
  it('an event AT the entry instant has already settled — rolled to the next one', () => {
    const r = fundingEventsInHold({ nextFundingTime: NOW, intervalHours: 8, holdHours: 4, nowMs: NOW });
    expect(r).toEqual({ events: 0, exact: true, nextFundingAt: NOW + 8 * H });
  });
  it('a STALE next time (in the past) is rolled forward by whole intervals, never dropped', () => {
    // HL's feed was measured serving 14:00Z at 14:38Z with a 1 h interval.
    const r = fundingEventsInHold({ nextFundingTime: NOW - 38 * 60_000, intervalHours: 1, holdHours: 2, nowMs: NOW });
    expect(r.exact).toBe(true);
    expect(r.nextFundingAt).toBe(NOW + 22 * 60_000);
    expect(r.events).toBe(2);
    const deep = fundingEventsInHold({ nextFundingTime: NOW - 3 * 8 * H - 1, intervalHours: 8, holdHours: 8, nowMs: NOW });
    expect(deep.nextFundingAt).toBe(NOW + 8 * H - 1);
    expect(deep.events).toBe(1);
  });
  it('no next time: hold / interval, exact false', () => {
    for (const t of [null, undefined, 0, Number.NaN, -5]) {
      expect(fundingEventsInHold({ nextFundingTime: t as number, intervalHours: 8, holdHours: 4, nowMs: NOW }))
        .toEqual({ events: 0.5, exact: false, nextFundingAt: null });
    }
  });
});

describe('fundingCostBps — + means the side pays', () => {
  it('a long pays a positive rate; a short receives it', () => {
    expect(fundingCostBps({ rate: 0.0001, side: 'long', events: 2 })).toBeCloseTo(2, 12);
    expect(fundingCostBps({ rate: 0.0001, side: 'short', events: 2 })).toBeCloseTo(-2, 12);
  });
  it('a short pays a negative rate', () => {
    expect(fundingCostBps({ rate: -0.0003, side: 'short', events: 1 })).toBeCloseTo(3, 12);
    expect(fundingCostBps({ rate: -0.0003, side: 'long', events: 1 })).toBeCloseTo(-3, 12);
  });
  it('sideSign', () => {
    expect(sideSign('long')).toBe(1);
    expect(sideSign('short')).toBe(-1);
  });
});

describe('entryAfterNextFundingSavingBps — funding now minus funding entered after the next event', () => {
  const base = { rate: 0.0001, side: 'long' as const, intervalHours: 8, nowMs: NOW };
  it('a hold shorter than the interval saves the one payment', () => {
    expect(entryAfterNextFundingSavingBps({ ...base, nextFundingTime: NOW + 20 * 60_000, holdHours: 4 })).toBeCloseTo(1, 12);
  });
  it('a whole-interval hold saves nothing: the shifted window picks up the following event', () => {
    expect(entryAfterNextFundingSavingBps({ ...base, nextFundingTime: NOW + 20 * 60_000, holdHours: 8 })).toBe(0);
  });
  it('a hold that ends before the next event saves nothing', () => {
    expect(entryAfterNextFundingSavingBps({ ...base, nextFundingTime: NOW + 2 * H, holdHours: 1 })).toBe(0);
  });
  it('a side that RECEIVES funding loses by waiting (negative)', () => {
    expect(entryAfterNextFundingSavingBps({ ...base, side: 'short', nextFundingTime: NOW + 20 * 60_000, holdHours: 4 })).toBeCloseTo(-1, 12);
  });
  it('null when the next funding time is unknown', () => {
    expect(entryAfterNextFundingSavingBps({ ...base, nextFundingTime: null, holdHours: 4 })).toBeNull();
  });
});

describe('topOfBookSpread', () => {
  it('(ask − bid) / mid in bps', () => {
    expect(topOfBookSpread({ bidPx: 9975, askPx: 10025 })).toEqual({ spreadBps: 50, basis: 'top_of_book' });
    expect(topOfBookSpread({ bidPx: 100, askPx: 100 })).toEqual({ spreadBps: 0, basis: 'top_of_book' });
  });
  it('unavailable — never 0 — for a missing, non-positive or crossed book', () => {
    for (const b of [{}, { bidPx: 100 }, { askPx: 100 }, { bidPx: 0, askPx: 1 }, { bidPx: 101, askPx: 100 }, { bidPx: Number.NaN, askPx: 1 }, { bidPx: null, askPx: null }]) {
      expect(topOfBookSpread(b)).toEqual({ spreadBps: null, basis: 'unavailable' });
    }
  });
});

describe('venueCapacityUsd', () => {
  it('a fraction of 24h volume', () => {
    expect(venueCapacityUsd(1_000_000_000, 0.001)).toBe(1_000_000);
  });
  it('null for an absent or non-positive volume', () => {
    for (const v of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(venueCapacityUsd(v as number, 0.001)).toBeNull();
  });
});
