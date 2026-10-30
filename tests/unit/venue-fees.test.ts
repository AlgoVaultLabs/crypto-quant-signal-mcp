/**
 * DECISION-CALL-V1-W2 R1 — the base-tier fee table `pre_trade_check` prices with.
 *
 * The META membership assertion is the CI gate the spec asks for: a fee row for a venue outside
 * `FUNDING_VENUE_META` could never be paired with a funding rate, and `decisionVenueSet` would drop
 * it without a word — so the drop is turned into a red build here instead.
 */
import { describe, it, expect } from 'vitest';
import {
  VENUE_FEE_ROWS,
  FEE_TABLE_MAX_AGE_DAYS,
  takerFeeBps,
  staleFeeRows,
  decisionVenueSet,
  feeRowVerifiedAtMs,
  type VenueFeeRow,
} from '../../src/lib/venue-fees.js';
import { FUNDING_VENUE_META } from '../../src/lib/funding-venues.js';

const DAY = 86_400_000;
const META_VENUES = new Set(Object.values(FUNDING_VENUE_META).map((m) => m.exchangeId));

describe('venue-fees — the table', () => {
  it('holds exactly the four verified rows, each with a source page and a verification day', () => {
    expect(VENUE_FEE_ROWS.map((r) => [r.exchange, r.makerPct, r.takerPct, r.verifiedAt])).toEqual([
      ['BINANCE', 0.02, 0.05, '2026-10-24'],
      ['BYBIT', 0.02, 0.055, '2026-10-24'],
      ['OKX', 0.02, 0.05, '2026-10-24'],
      ['BITGET', 0.02, 0.06, '2026-10-27'],
    ]);
    for (const r of VENUE_FEE_ROWS) {
      expect(r.sourceUrl).toMatch(/^https:\/\//);
      expect(r.basis).toBe('base_tier_usdt_perpetual');
      expect(Number.isFinite(feeRowVerifiedAtMs(r))).toBe(true);
    }
  });

  it('CI GATE: every fee row is a FUNDING_VENUE_META venue (a fee with no funding feed fails here)', () => {
    const outside = VENUE_FEE_ROWS.filter((r) => !META_VENUES.has(r.exchange)).map((r) => r.exchange);
    expect(outside, 'fee rows outside FUNDING_VENUE_META').toEqual([]);
  });

  it('the gate can fail: a row outside META is dropped by the decision set and caught by the same predicate', () => {
    const rogue: VenueFeeRow = { ...VENUE_FEE_ROWS[0], exchange: 'MEXC' };
    const rows = [...VENUE_FEE_ROWS, rogue];
    expect(rows.filter((r) => !META_VENUES.has(r.exchange)).map((r) => r.exchange)).toEqual(['MEXC']);
    expect(decisionVenueSet(new Set(), rows)).not.toContain('MEXC');
  });

  it('rows are frozen', () => {
    expect(Object.isFrozen(VENUE_FEE_ROWS)).toBe(true);
    expect(Object.isFrozen(VENUE_FEE_ROWS[0])).toBe(true);
  });
});

describe('venue-fees — takerFeeBps', () => {
  it('converts percent to basis points exactly', () => {
    expect(takerFeeBps('BINANCE')).toBe(5);
    expect(takerFeeBps('BYBIT')).toBe(5.5);
    expect(takerFeeBps('OKX')).toBe(5);
    expect(takerFeeBps('BITGET')).toBe(6);
  });
  it('null for a venue with no row — never a guessed fee', () => {
    expect(takerFeeBps('HL')).toBeNull();
    expect(takerFeeBps('NOPE')).toBeNull();
  });
});

describe('venue-fees — staleFeeRows at 89 / 90 / 91 days', () => {
  const row = VENUE_FEE_ROWS[0];
  const t0 = feeRowVerifiedAtMs(row);
  const only = [row];
  it(`the bound is ${FEE_TABLE_MAX_AGE_DAYS} days`, () => expect(FEE_TABLE_MAX_AGE_DAYS).toBe(90));
  it('89 days: fresh', () => expect(staleFeeRows(t0 + 89 * DAY, only)).toEqual([]));
  it('90 days exactly: fresh (the bound is inclusive)', () => expect(staleFeeRows(t0 + 90 * DAY, only)).toEqual([]));
  it('90 days + 1 ms: stale', () => expect(staleFeeRows(t0 + 90 * DAY + 1, only)).toEqual([row]));
  it('91 days: stale', () => expect(staleFeeRows(t0 + 91 * DAY, only)).toEqual([row]));
  it('an unparseable day is stale, never silently fresh', () => {
    const bad: VenueFeeRow = { ...row, verifiedAt: 'soon' };
    expect(staleFeeRows(t0, [bad])).toEqual([bad]);
  });
  it('the live table is fresh on its own verification day', () => {
    expect(staleFeeRows(Date.parse('2026-10-30T00:00:00Z'))).toEqual([]);
  });
});

describe('venue-fees — decisionVenueSet', () => {
  it('rows ∩ META, in META order', () => {
    expect(decisionVenueSet(new Set())).toEqual(['BINANCE', 'BYBIT', 'OKX', 'BITGET']);
  });
  it('minus the retired venues', () => {
    expect(decisionVenueSet(new Set(['OKX']))).toEqual(['BINANCE', 'BYBIT', 'BITGET']);
    expect(decisionVenueSet(new Set(['BINANCE', 'BYBIT', 'OKX', 'BITGET']))).toEqual([]);
  });
});
