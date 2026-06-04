/**
 * Unit tests for the pure underlying-market session classifier
 * (TRADIFI-SIGNAL-HARDENING-W1, R1/R7).
 *
 * Covers: weekend/RTH/holiday/extended for EQUITY (via America/New_York, DST-
 * aware), KR_EQUITY + COMMODITY weekend-level, PREMARKET, CRYPTO, the
 * note-gating contract, and the holiday-table staleness canary.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyUnderlyingSession,
  isClosedState,
} from '../../src/lib/market-sessions.js';
import {
  US_MARKET_HOLIDAYS,
  isUsMarketHoliday,
  latestHolidayYear,
} from '../../src/lib/market-sessions-constants.js';

describe('classifyUnderlyingSession — EQUITY (US sessions)', () => {
  it('Saturday 12:00 UTC → CLOSED_WEEKEND with a non-empty note', () => {
    const r = classifyUnderlyingSession({ assetClass: 'EQUITY', at: new Date('2026-06-06T12:00:00Z') }); // Sat
    expect(r.state).toBe('CLOSED_WEEKEND');
    expect(r.note).not.toBe('');
  });

  it('Wednesday 15:00 UTC (summer) → OPEN_REGULAR (11:00 EDT, within RTH)', () => {
    const r = classifyUnderlyingSession({ assetClass: 'EQUITY', at: new Date('2026-06-10T15:00:00Z') }); // Wed
    expect(r.state).toBe('OPEN_REGULAR');
    expect(r.note).toBe(''); // open-regular emits no session_note
  });

  it('NYSE full-holiday date → CLOSED_HOLIDAY (Independence Day observed 2026-07-03)', () => {
    const r = classifyUnderlyingSession({ assetClass: 'EQUITY', at: new Date('2026-07-03T18:00:00Z') }); // Fri, holiday, 14:00 ET
    expect(r.state).toBe('CLOSED_HOLIDAY');
    expect(r.note).not.toBe('');
  });

  it('weekday pre-market → OPEN_EXTENDED with a note (08:00 EDT)', () => {
    const r = classifyUnderlyingSession({ assetClass: 'EQUITY', at: new Date('2026-06-10T12:00:00Z') }); // Wed 08:00 EDT
    expect(r.state).toBe('OPEN_EXTENDED');
    expect(r.note).not.toBe('');
  });

  it('weekday after-hours → OPEN_EXTENDED (16:30 EDT, just past close)', () => {
    const r = classifyUnderlyingSession({ assetClass: 'EQUITY', at: new Date('2026-06-10T20:30:00Z') }); // Wed 16:30 EDT
    expect(r.state).toBe('OPEN_EXTENDED');
  });

  // DST sanity: the SAME wall-clock UTC maps to different ET depending on DST,
  // so the RTH boundary must move with it. 20:30 UTC is 15:30 EST (winter, RTH)
  // but 16:30 EDT (summer, after close).
  it('DST boundary: 2026-01-07 20:30 UTC (EST) → OPEN_REGULAR (15:30 ET)', () => {
    const r = classifyUnderlyingSession({ assetClass: 'EQUITY', at: new Date('2026-01-07T20:30:00Z') }); // Wed winter
    expect(r.state).toBe('OPEN_REGULAR');
  });

  it('DST boundary: 2026-07-08 20:30 UTC (EDT) → OPEN_EXTENDED (16:30 ET)', () => {
    const r = classifyUnderlyingSession({ assetClass: 'EQUITY', at: new Date('2026-07-08T20:30:00Z') }); // Wed summer
    expect(r.state).toBe('OPEN_EXTENDED');
  });

  it('winter RTH open boundary: 2026-01-07 14:30 UTC (09:30 EST) → OPEN_REGULAR', () => {
    const r = classifyUnderlyingSession({ assetClass: 'EQUITY', at: new Date('2026-01-07T14:30:00Z') });
    expect(r.state).toBe('OPEN_REGULAR');
  });
});

describe('classifyUnderlyingSession — other classes', () => {
  it('PREMARKET any time → PREIPO_INTERNAL with a note', () => {
    const weekday = classifyUnderlyingSession({ assetClass: 'PREMARKET', at: new Date('2026-06-10T15:00:00Z') });
    const weekend = classifyUnderlyingSession({ assetClass: 'PREMARKET', at: new Date('2026-06-06T12:00:00Z') });
    expect(weekday.state).toBe('PREIPO_INTERNAL');
    expect(weekend.state).toBe('PREIPO_INTERNAL');
    expect(weekday.note).not.toBe('');
  });

  it('CRYPTO any time → ALWAYS_OPEN, no note', () => {
    const r = classifyUnderlyingSession({ assetClass: 'CRYPTO', at: new Date('2026-06-06T12:00:00Z') });
    expect(r.state).toBe('ALWAYS_OPEN');
    expect(r.note).toBe('');
  });

  it('KR_EQUITY weekend → CLOSED_WEEKEND (v1 weekend-level), weekday → OPEN_REGULAR', () => {
    const wknd = classifyUnderlyingSession({ assetClass: 'KR_EQUITY', at: new Date('2026-06-06T12:00:00Z') });
    const wkdy = classifyUnderlyingSession({ assetClass: 'KR_EQUITY', at: new Date('2026-06-10T03:00:00Z') });
    expect(wknd.state).toBe('CLOSED_WEEKEND');
    expect(wknd.note).toMatch(/weekend-level|approximation/i); // names the simplification
    expect(wkdy.state).toBe('OPEN_REGULAR');
  });

  it('COMMODITY weekend → CLOSED_WEEKEND, weekday → OPEN_REGULAR', () => {
    const wknd = classifyUnderlyingSession({ assetClass: 'COMMODITY', at: new Date('2026-06-07T12:00:00Z') }); // Sun
    const wkdy = classifyUnderlyingSession({ assetClass: 'COMMODITY', at: new Date('2026-06-10T15:00:00Z') });
    expect(wknd.state).toBe('CLOSED_WEEKEND');
    expect(wkdy.state).toBe('OPEN_REGULAR');
  });
});

describe('isClosedState', () => {
  it('true only for CLOSED_WEEKEND / CLOSED_HOLIDAY', () => {
    expect(isClosedState('CLOSED_WEEKEND')).toBe(true);
    expect(isClosedState('CLOSED_HOLIDAY')).toBe(true);
    expect(isClosedState('OPEN_REGULAR')).toBe(false);
    expect(isClosedState('OPEN_EXTENDED')).toBe(false);
    expect(isClosedState('ALWAYS_OPEN')).toBe(false);
    expect(isClosedState('PREIPO_INTERNAL')).toBe(false);
    expect(isClosedState('UNKNOWN')).toBe(false);
  });
});

describe('US_MARKET_HOLIDAYS table — content + staleness canary', () => {
  it('covers both 2026 and 2027 with the canonical full-closure dates', () => {
    // Regression guard: dropping MLK / Thanksgiving / the observed Independence
    // Day would silently disable the holiday caveat on those dates.
    const dates = new Set(US_MARKET_HOLIDAYS.map(h => h.date));
    for (const d of [
      '2026-01-19', // MLK
      '2026-07-03', // Independence Day observed (Jul 4 is Saturday) — FULL closure
      '2026-11-26', // Thanksgiving
      '2026-12-25', // Christmas
      '2027-01-18', // MLK
      '2027-07-05', // Independence Day observed (Jul 4 is Sunday)
      '2027-11-25', // Thanksgiving
    ]) {
      expect(dates.has(d), `holiday table missing ${d}`).toBe(true);
    }
    expect(isUsMarketHoliday('2026-07-03')).toBe(true);
    expect(isUsMarketHoliday('2026-06-10')).toBe(false); // ordinary trading day
  });

  it('every entry cites a source and uses ISO YYYY-MM-DD', () => {
    for (const h of US_MARKET_HOLIDAYS) {
      expect(h.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(h.source.length).toBeGreaterThan(0);
      expect(h.name.length).toBeGreaterThan(0);
    }
  });

  // Staleness canary: forces a refresh each year-end. Fails once we are in the
  // final calendar month of the latest covered year without the next year's
  // NYSE table. When it trips, append the next year's calendar to
  // US_MARKET_HOLIDAYS in market-sessions-constants.ts.
  it('holiday table is not stale (covers the current year, and next year by December)', () => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const requiredYear = now.getUTCMonth() === 11 ? year + 1 : year; // December → need next year
    expect(
      latestHolidayYear(),
      `NYSE holiday table is stale — add the ${requiredYear} calendar to US_MARKET_HOLIDAYS`,
    ).toBeGreaterThanOrEqual(requiredYear);
  });
});
