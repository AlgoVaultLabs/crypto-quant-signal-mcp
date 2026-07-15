/**
 * tests/unit/funding-venues.test.ts — OPS-FUNDING-ARB-EXPAND-W1 C1.
 *
 * The funding-arb venue SoT (FUNDING_VENUE_META) + interval-correct normalization via the SHARED
 * annualizeFunding primitive. Pins: the architect-ratified qualifying set, per-interval annualization
 * (8h/4h/1h), cross-venue equivalence, and the 0-regression identity the engine relies on
 * (annualized / 8760 === rate / intervalHours).
 */
import { describe, it, expect } from 'vitest';
import { annualizeFunding } from '../../src/lib/rank-constants.js';
import {
  FUNDING_VENUE_META,
  FUNDING_ARB_FETCH_ADAPTERS,
  FUNDING_VENUE_COUNT,
  FUNDING_VENUE_LABELS,
  FUNDING_VENUE_LIST_TEXT,
} from '../../src/lib/funding-venues.js';

describe('FUNDING_VENUE_META — the qualifying-venue SoT', () => {
  it('is exactly the 7 architect-ratified venues with correct intervals', () => {
    expect(Object.keys(FUNDING_VENUE_META).sort()).toEqual(
      ['AsterPerp', 'BinPerp', 'BybitPerp', 'GatePerp', 'HlPerp', 'KuCoinPerp', 'OKXPerp'].sort(),
    );
    expect(FUNDING_VENUE_META.HlPerp).toEqual({ exchangeId: 'HL', intervalHours: 1 }); // HL hourly
    expect(FUNDING_VENUE_META.BinPerp.intervalHours).toBe(8);
    // EXCLUDED: BITGET (no nextFundingTime → degraded urgency) + MEXC/HTX/BINGX/PHEMEX (empty feed)
    for (const excluded of ['BitgetPerp', 'MexcPerp', 'HtxPerp', 'BingxPerp', 'PhemexPerp']) {
      expect(FUNDING_VENUE_META).not.toHaveProperty(excluded);
    }
  });

  it('fetch-adapter set uses the HL aggregate for Bin/Bybit (no double-count)', () => {
    expect([...FUNDING_ARB_FETCH_ADAPTERS]).toEqual(['HL', 'GATE', 'KUCOIN', 'ASTER', 'OKX']);
  });
});

describe('FUNDING_VENUE_COUNT — the public funding venue count SoT (OPS-LANDING-FUNDING-VENUE-RECONCILE-W1)', () => {
  it('== |FUNDING_VENUE_META| == 7 (the qualifying set the engine actually reports)', () => {
    expect(FUNDING_VENUE_COUNT).toBe(Object.keys(FUNDING_VENUE_META).length);
    expect(FUNDING_VENUE_COUNT).toBe(7);
  });

  it('is NOT the fetch-adapter count (=5): the public claim must derive from META, not FETCH_ADAPTERS', () => {
    // HL's aggregate feed fans out to HL+Binance+Bybit, so 5 fetch adapters → 7 venues.
    // Guards the CH1 spec-correction: FUNDING_ARB_FETCH_ADAPTERS.length would understate the count.
    expect(FUNDING_ARB_FETCH_ADAPTERS.length).toBe(5);
    expect(FUNDING_VENUE_COUNT).not.toBe(FUNDING_ARB_FETCH_ADAPTERS.length);
  });

  it('name-list length == count (Q4b coupling): a future META add that bumps the count but not the names FAILS here', () => {
    expect(FUNDING_VENUE_LABELS.length).toBe(FUNDING_VENUE_COUNT);
  });

  it('labels are exactly the 7 named venues in the canonical (docs.html) copy order', () => {
    // Exact match also proves no label fell back to a raw exchangeId (e.g. 'HL' → 'Hyperliquid').
    expect([...FUNDING_VENUE_LABELS]).toEqual([
      'Hyperliquid', 'Binance', 'Bybit', 'Gate', 'KuCoin', 'Aster', 'OKX',
    ]);
  });

  it('never inflates ahead of the engine: Bitget stays excluded from the public count + name list', () => {
    expect(FUNDING_VENUE_LABELS).not.toContain('Bitget');
    expect(FUNDING_VENUE_META).not.toHaveProperty('BitgetPerp');
  });

  it('FUNDING_VENUE_LIST_TEXT is the Oxford-joined public-copy string (mirrored on the landing pages)', () => {
    expect(FUNDING_VENUE_LIST_TEXT).toBe('Hyperliquid, Binance, Bybit, Gate, KuCoin, Aster, and OKX');
    // the copy string names exactly FUNDING_VENUE_COUNT venues (comma + trailing "and")
    expect(FUNDING_VENUE_LIST_TEXT.split(/,\s*(?:and\s+)?/).filter(Boolean).length).toBe(FUNDING_VENUE_COUNT);
  });
});

describe('annualizeFunding — interval-correct normalization (C1)', () => {
  it('annualizes 8h / 4h / 1h by the venue interval (rate × 24/h × 365)', () => {
    expect(annualizeFunding(0.0001, 8)).toBeCloseTo(0.0001 * 3 * 365, 12); // 8h → ×1095
    expect(annualizeFunding(0.0001, 4)).toBeCloseTo(0.0001 * 6 * 365, 12); // 4h → ×2190
    expect(annualizeFunding(0.0001, 1)).toBeCloseTo(0.0001 * 24 * 365, 12); // 1h → ×8760
  });

  it('cross-venue equivalence: identical daily funding annualizes identically across intervals', () => {
    // 0.01%/8h  ==  0.005%/4h  (both 0.03%/day) → same annualized APR
    expect(annualizeFunding(0.0001, 8)).toBeCloseTo(annualizeFunding(0.00005, 4)!, 12);
  });

  it('0-regression identity: annualized / 8760 === rate / intervalHours (the engine hourly rate)', () => {
    for (const [rate, h] of [[0.0001, 1], [0.0003, 8], [-0.0002, 8]] as const) {
      expect(annualizeFunding(rate, h)! / 8760).toBeCloseTo(rate / h, 15);
    }
  });

  it('returns null on an unknown/invalid interval (never guesses → no false spread)', () => {
    expect(annualizeFunding(0.0001, 0)).toBeNull();
    expect(annualizeFunding(0.0001, null)).toBeNull();
    expect(annualizeFunding(Number.NaN, 8)).toBeNull();
  });
});
