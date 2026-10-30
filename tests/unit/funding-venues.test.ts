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
  it('is exactly the 8 qualifying venues with correct intervals', () => {
    // DECISION-CALL-V1-W1 R3: Bitget joined (its current-fund-rate feed publishes the next funding time).
    expect(Object.keys(FUNDING_VENUE_META).sort()).toEqual(
      ['AsterPerp', 'BinPerp', 'BitgetPerp', 'BybitPerp', 'GatePerp', 'HlPerp', 'KuCoinPerp', 'OKXPerp'].sort(),
    );
    // DECISION-CALL-V1-W1 R2: each row names the adapter whose feed carries it (`fetchedVia`).
    expect(FUNDING_VENUE_META.HlPerp).toEqual({ exchangeId: 'HL', intervalHours: 1, fetchedVia: 'HL' }); // HL hourly
    expect(FUNDING_VENUE_META.BinPerp.intervalHours).toBe(8);
    expect(FUNDING_VENUE_META.BitgetPerp).toEqual({ exchangeId: 'BITGET', intervalHours: 8, fetchedVia: 'BITGET' });
    // EXCLUDED: MEXC/HTX/BINGX/PHEMEX (empty feed)
    for (const excluded of ['MexcPerp', 'HtxPerp', 'BingxPerp', 'PhemexPerp']) {
      expect(FUNDING_VENUE_META).not.toHaveProperty(excluded);
    }
  });

  it('every venue is fetched from its OWN feed — Binance and Bybit no longer via the HL aggregate', () => {
    // DECISION-CALL-V1-W1 R3: HL's copy covered 41% / 68% of Binance's / Bybit's top 100; their own
    // bulk feeds 96% / 98% (R0, 2026-10-24).
    for (const [venue, m] of Object.entries(FUNDING_VENUE_META)) {
      expect(m.fetchedVia, venue).toBe(m.exchangeId);
    }
    expect([...FUNDING_ARB_FETCH_ADAPTERS]).toEqual(['HL', 'BINANCE', 'BYBIT', 'GATE', 'KUCOIN', 'ASTER', 'OKX', 'BITGET']);
  });

  it('FUNDING_ARB_FETCH_ADAPTERS is DERIVED: the unique fetchedVia values in META order', () => {
    expect([...FUNDING_ARB_FETCH_ADAPTERS]).toEqual([...new Set(Object.values(FUNDING_VENUE_META).map((m) => m.fetchedVia))]);
  });
});

describe('FUNDING_VENUE_COUNT — the public funding venue count SoT (OPS-LANDING-FUNDING-VENUE-RECONCILE-W1)', () => {
  it('== |FUNDING_VENUE_META| == 8 (the qualifying set the engine actually reports)', () => {
    expect(FUNDING_VENUE_COUNT).toBe(Object.keys(FUNDING_VENUE_META).length);
    // DECISION-CALL-V1-W1 R3: 7 → 8 (Bitget).
    expect(FUNDING_VENUE_COUNT).toBe(8);
  });

  it('derives from META, not from the fetch-adapter count — equal today only because no feed aggregates', () => {
    // DECISION-CALL-V1-W1 R3: before R3, HL's aggregate fanned 5 adapters out to 7 venues, and this
    // test pinned the inequality. With every venue on its own feed the counts coincide; what stays
    // pinned is that the public count is the META row count, one per venue-string.
    expect(FUNDING_VENUE_COUNT).toBe(new Set(Object.values(FUNDING_VENUE_META).map((m) => m.exchangeId)).size);
    expect(FUNDING_ARB_FETCH_ADAPTERS.length).toBe(FUNDING_VENUE_COUNT);
  });

  it('name-list length == count (Q4b coupling): a future META add that bumps the count but not the names FAILS here', () => {
    expect(FUNDING_VENUE_LABELS.length).toBe(FUNDING_VENUE_COUNT);
  });

  it('labels are exactly the 8 named venues in the canonical (docs.html) copy order', () => {
    // Exact match also proves no label fell back to a raw exchangeId (e.g. 'HL' → 'Hyperliquid').
    expect([...FUNDING_VENUE_LABELS]).toEqual([
      'Hyperliquid', 'Binance', 'Bybit', 'Gate', 'KuCoin', 'Aster', 'OKX', 'Bitget',
    ]);
  });

  it('never inflates ahead of the engine: Bitget is counted only because the engine reads its feed', () => {
    // DECISION-CALL-V1-W1 R3 flipped this from "Bitget stays excluded": the label exists exactly when
    // the META row (and so the fetch adapter) does.
    expect(FUNDING_VENUE_LABELS).toContain('Bitget');
    expect(FUNDING_ARB_FETCH_ADAPTERS).toContain('BITGET');
  });

  it('FUNDING_VENUE_LIST_TEXT is the Oxford-joined public-copy string (mirrored on the landing pages)', () => {
    // DECISION-CALL-V1-W1 R5: the approved public line (Mr.1, 2026-10-27).
    expect(FUNDING_VENUE_LIST_TEXT).toBe('Hyperliquid, Binance, Bybit, Gate, KuCoin, Aster, OKX, and Bitget');
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
