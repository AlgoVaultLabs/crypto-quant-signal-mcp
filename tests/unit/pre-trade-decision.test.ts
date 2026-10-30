/**
 * DECISION-CALL-V1-W2 R3 — the `pre_trade_check` engine: exclusion order, ranking, split, every
 * threshold on both sides of its boundary, and the decision mapping.
 */
import { describe, it, expect } from 'vitest';
import {
  rankVenues,
  decide,
  PRE_TRADE_RULE_VERSION,
  PRE_TRADE_REASONS,
  VENUE_EXCLUSIONS,
  MIN_VENUE_LIQUIDITY_USD,
  WIDE_SPREAD_BPS,
  HIGH_CARRY_BPS,
  FUNDING_SOON_MINUTES,
  MIN_TIMING_SAVING_BPS,
  REGIME_AGAINST_MIN_CONFIDENCE,
  VOLATILE_MIN_CONFIDENCE,
  SIZE_MAX_PCT_OF_24H_VOLUME,
  type VenueMarketInput,
  type RankVenuesInput,
  type DecideInput,
  type RegimeRead,
} from '../../src/lib/pre-trade-decision.js';

const H = 3_600_000;
const MIN = 60_000;
const NOW = Date.parse('2026-10-30T12:00:00Z');

/** A healthy venue: liquid, unquoted book, 1 bp of funding per 8 h, next event 4 h out, 5 bp taker. */
function venue(over: Partial<VenueMarketInput> & { exchange?: string } = {}): VenueMarketInput {
  return {
    exchange: 'BINANCE',
    universeOk: true,
    fundingFeedOk: true,
    asset: { liquidityUsd: 500_000_000, volume24hUsd: 10_000_000_000 },
    funding: { rate: 0.0001, intervalHours: 8, intervalBasis: 'contract', nextFundingTime: NOW + 4 * H },
    takerFeeBps: 5,
    ...over,
  };
}

function rank(venues: VenueMarketInput[], over: Partial<RankVenuesInput> = {}) {
  return rankVenues({ venues, side: 'long', sizeUsd: 10_000, holdHours: 8, nowMs: NOW, ...over });
}

function judge(venues: VenueMarketInput[], over: Partial<DecideInput> & { rankOver?: Partial<RankVenuesInput> } = {}) {
  const { rankOver, ...rest } = over;
  const r = rank(venues, { ...rankOver, side: rest.side ?? rankOver?.side ?? 'long', sizeUsd: rest.sizeUsd ?? rankOver?.sizeUsd ?? 10_000, holdHours: rest.holdHours ?? rankOver?.holdHours ?? 8 });
  return decide({
    coin: 'BTC',
    side: 'long',
    sizeUsd: 10_000,
    holdHours: 8,
    timeframe: '4h',
    nowMs: NOW,
    ranking: r,
    regime: { label: 'RANGING', confidence: 50, timeframe: '4h', asOfMs: NOW - H, sourceExchange: 'BINANCE' },
    underlyingClosed: false,
    staleFees: [],
    ...rest,
  });
}
const codes = (d: { reasons: { code: string }[] }) => d.reasons.map((r) => r.code);

describe('constants — the versioned rule', () => {
  it('rule version 1 with the contract thresholds', () => {
    expect(PRE_TRADE_RULE_VERSION).toBe(1);
    expect([MIN_VENUE_LIQUIDITY_USD, WIDE_SPREAD_BPS, HIGH_CARRY_BPS, FUNDING_SOON_MINUTES, MIN_TIMING_SAVING_BPS,
      REGIME_AGAINST_MIN_CONFIDENCE, VOLATILE_MIN_CONFIDENCE, SIZE_MAX_PCT_OF_24H_VOLUME])
      .toEqual([1e6, 50, 10, 30, 1, 60, 70, 0.001]);
  });
  it('exclusion order and reason severities are the contract\'s', () => {
    expect([...VENUE_EXCLUSIONS]).toEqual(['feed_unavailable', 'not_listed', 'thin_liquidity', 'wide_book', 'funding_unavailable', 'fee_unknown', 'volume_unavailable']);
    expect(Object.entries(PRE_TRADE_REASONS).filter(([, s]) => s === 'block').map(([c]) => c)).toEqual(['NO_TRADABLE_VENUE']);
    expect(Object.entries(PRE_TRADE_REASONS).filter(([, s]) => s === 'adjust').map(([c]) => c)).toEqual(
      ['SIZE_ABOVE_VENUE_LIMIT', 'SIZE_ABOVE_TOTAL_CAPACITY', 'FUNDING_COST_HIGH', 'FUNDING_DUE_SOON', 'REGIME_AGAINST_SIDE', 'REGIME_VOLATILE', 'UNDERLYING_CLOSED']);
    expect(Object.entries(PRE_TRADE_REASONS).filter(([, s]) => s === 'info').map(([c]) => c)).toEqual(
      ['REGIME_UNAVAILABLE', 'VENUES_UNAVAILABLE', 'NEXT_FUNDING_UNKNOWN', 'FUNDING_INCOME', 'FEE_TABLE_STALE']);
  });
});

describe('rankVenues — per-venue figures', () => {
  it('round trip = 2 × taker; estimated cost = round trip + funding; USD at the order size', () => {
    const v = rank([venue({ takerFeeBps: 5.5 })]).venues[0];
    expect(v).toMatchObject({
      listed: true, excluded: null, takerFeeBps: 5.5, roundTripFeeBps: 11, fundingEventsInHold: 1, fundingEventsExact: true,
      fundingCostBps: 1, estCostBps: 12, estCostUsd: 12, capacityUsd: 10_000_000, sizePctOf24hVolume: 0.0001,
      fundingIntervalBasis: 'contract', nextFundingAtMs: NOW + 4 * H, spreadBps: null, spreadBasis: 'unavailable',
    });
  });
  it('a short receiving funding has a negative funding cost that lowers the estimate', () => {
    const v = rank([venue()], { side: 'short' }).venues[0];
    expect(v.fundingCostBps).toBe(-1);
    expect(v.estCostBps).toBe(9);
  });
  it('a quoted book reports its spread', () => {
    expect(rank([venue({ asset: { liquidityUsd: 5e8, volume24hUsd: 1e10, bidPx: 9999, askPx: 10001 } })]).venues[0])
      .toMatchObject({ spreadBps: 2, spreadBasis: 'top_of_book' });
  });
});

describe('rankVenues — exclusion, first failing', () => {
  const ex = (v: VenueMarketInput) => rank([v]).venues[0].excluded;
  it('feed_unavailable beats everything (universe OR funding feed down)', () => {
    expect(ex(venue({ universeOk: false, asset: null, funding: null, takerFeeBps: null }))).toBe('feed_unavailable');
    expect(ex(venue({ fundingFeedOk: false }))).toBe('feed_unavailable');
    expect(rank([venue({ universeOk: false })]).venues[0].listed).toBeNull();
  });
  it('not_listed', () => expect(ex(venue({ asset: null, funding: null }))).toBe('not_listed'));
  it(`thin_liquidity: below ${MIN_VENUE_LIQUIDITY_USD} excluded, exactly at it kept`, () => {
    expect(ex(venue({ asset: { liquidityUsd: 999_999.99, volume24hUsd: 1e10 } }))).toBe('thin_liquidity');
    expect(ex(venue({ asset: { liquidityUsd: 1_000_000, volume24hUsd: 1e10 } }))).toBeNull();
    expect(ex(venue({ asset: { liquidityUsd: Number.NaN, volume24hUsd: 1e10 } }))).toBe('thin_liquidity');
  });
  it(`wide_book: a spread of exactly ${WIDE_SPREAD_BPS} bps is kept, above it excluded — top_of_book only`, () => {
    expect(ex(venue({ asset: { liquidityUsd: 5e8, volume24hUsd: 1e10, bidPx: 9975, askPx: 10025 } }))).toBeNull();
    expect(ex(venue({ asset: { liquidityUsd: 5e8, volume24hUsd: 1e10, bidPx: 9974.99, askPx: 10025.01 } }))).toBe('wide_book');
    expect(ex(venue({ asset: { liquidityUsd: 5e8, volume24hUsd: 1e10, bidPx: 9000 } }))).toBeNull(); // no ask: unavailable, never excluded
  });
  it('funding_unavailable, then fee_unknown, then volume_unavailable', () => {
    expect(ex(venue({ funding: null, takerFeeBps: null, asset: { liquidityUsd: 5e8, volume24hUsd: null } }))).toBe('funding_unavailable');
    expect(ex(venue({ takerFeeBps: null, asset: { liquidityUsd: 5e8, volume24hUsd: null } }))).toBe('fee_unknown');
    expect(ex(venue({ asset: { liquidityUsd: 5e8, volume24hUsd: null } }))).toBe('volume_unavailable');
    expect(ex(venue({ asset: { liquidityUsd: 5e8, volume24hUsd: 0 } }))).toBe('volume_unavailable');
  });
});

describe('rankVenues — the best venue and the split', () => {
  it('lowest estimated cost wins', () => {
    const r = rank([venue({ exchange: 'BINANCE', takerFeeBps: 5.5 }), venue({ exchange: 'BYBIT', takerFeeBps: 5 })]);
    expect(r.best?.exchange).toBe('BYBIT');
    expect(r.candidates.map((c) => c.exchange)).toEqual(['BYBIT', 'BINANCE']);
  });
  it('ties: higher liquidity, then input (META) order', () => {
    const lo = { liquidityUsd: 2e8, volume24hUsd: 1e10 };
    const hi = { liquidityUsd: 9e8, volume24hUsd: 1e10 };
    expect(rank([venue({ exchange: 'BINANCE', asset: lo }), venue({ exchange: 'BYBIT', asset: hi })]).best?.exchange).toBe('BYBIT');
    expect(rank([venue({ exchange: 'BINANCE', asset: hi }), venue({ exchange: 'BYBIT', asset: hi })]).best?.exchange).toBe('BINANCE');
  });
  it('a cheaper venue that cannot fit the order loses to one that can; capacity == size fits', () => {
    const small = { liquidityUsd: 5e8, volume24hUsd: 9_999_000 }; // capacity 9,999
    const exact = { liquidityUsd: 5e8, volume24hUsd: 10_000_000 }; // capacity 10,000
    const r = rank([venue({ exchange: 'BINANCE', asset: small, takerFeeBps: 1 }), venue({ exchange: 'BYBIT', asset: exact, takerFeeBps: 6 })]);
    expect(r.best?.exchange).toBe('BYBIT');
    expect(r.split).toBeNull();
    expect(r.sizeLimitUsd).toBe(10_000);
    expect(r.sizeLimitUsdTotal).toBe(19_999);
  });
  it('above every venue\'s capacity: the cheapest leads and the split fills cheapest-first to capacity', () => {
    const r = rank([
      venue({ exchange: 'BINANCE', asset: { liquidityUsd: 5e8, volume24hUsd: 4_000_000 }, takerFeeBps: 5 }),
      venue({ exchange: 'BYBIT', asset: { liquidityUsd: 5e8, volume24hUsd: 3_000_000 }, takerFeeBps: 4 }),
      venue({ exchange: 'OKX', asset: { liquidityUsd: 5e8, volume24hUsd: 5_000_000 }, takerFeeBps: 6 }),
    ], { sizeUsd: 10_000 });
    expect(r.best?.exchange).toBe('BYBIT');
    expect(r.split).toEqual([
      { exchange: 'BYBIT', sizeUsd: 3_000, estCostBps: 9 },
      { exchange: 'BINANCE', sizeUsd: 4_000, estCostBps: 11 },
      { exchange: 'OKX', sizeUsd: 3_000, estCostBps: 13 },
    ]);
  });
  it('above the TOTAL capacity: every venue filled to its limit, the rest unplaced', () => {
    const r = rank([
      venue({ exchange: 'BINANCE', asset: { liquidityUsd: 5e8, volume24hUsd: 4_000_000 } }),
      venue({ exchange: 'BYBIT', asset: { liquidityUsd: 5e8, volume24hUsd: 3_000_000 } }),
    ], { sizeUsd: 10_000 });
    expect(r.sizeLimitUsdTotal).toBe(7_000);
    expect(r.split?.reduce((s, l) => s + l.sizeUsd, 0)).toBe(7_000);
  });
  it('no candidate: no best, no limits, no split', () => {
    const r = rank([venue({ asset: null, funding: null })]);
    expect([r.best, r.sizeLimitUsd, r.sizeLimitUsdTotal, r.split]).toEqual([null, null, null, null]);
  });
});

describe('decide — every threshold, both sides of the boundary', () => {
  it('GO when nothing is wrong', () => {
    const d = judge([venue()]);
    expect(d.decision).toBe('GO');
    expect(d.reasons).toEqual([]);
  });

  it('NO_TRADABLE_VENUE blocks → WAIT, naming each venue\'s exclusion in plain words', () => {
    const d = judge([venue({ asset: { liquidityUsd: 10, volume24hUsd: 1e10 } }), venue({ exchange: 'OKX', asset: null, funding: null })]);
    expect(d.decision).toBe('WAIT');
    expect(codes(d)).toContain('NO_TRADABLE_VENUE');
    expect(d.reasons[0].detail).toBe('No venue can take this long on BTC: BINANCE liquidity below $1,000,000; OKX not listed.');
    expect(d.timing).toBeNull();
  });

  it('SIZE_ABOVE_VENUE_LIMIT: size == capacity is fine, a cent above adjusts', () => {
    const one = [venue({ asset: { liquidityUsd: 5e8, volume24hUsd: 10_000_000 } }), venue({ exchange: 'BYBIT', asset: { liquidityUsd: 5e8, volume24hUsd: 10_000_000 } })];
    expect(codes(judge(one, { sizeUsd: 10_000 }))).not.toContain('SIZE_ABOVE_VENUE_LIMIT');
    const d = judge(one, { sizeUsd: 10_000.01 });
    expect(codes(d)).toEqual(['SIZE_ABOVE_VENUE_LIMIT']);
    expect(d.decision).toBe('CAUTION');
  });

  it('SIZE_ABOVE_TOTAL_CAPACITY replaces the venue reason when even the sum cannot take it', () => {
    const d = judge([venue({ asset: { liquidityUsd: 5e8, volume24hUsd: 4_000_000 } })], { sizeUsd: 10_000 });
    expect(codes(d)).toEqual(['SIZE_ABOVE_TOTAL_CAPACITY']);
  });

  it(`FUNDING_COST_HIGH at ${HIGH_CARRY_BPS} bps, not below`, () => {
    const at = venue({ funding: { rate: 0.001, intervalHours: 8, intervalBasis: 'contract', nextFundingTime: NOW + 4 * H } });
    const below = venue({ funding: { rate: 0.00099999, intervalHours: 8, intervalBasis: 'contract', nextFundingTime: NOW + 4 * H } });
    expect(codes(judge([at]))).toEqual(['FUNDING_COST_HIGH']);
    expect(codes(judge([below]))).toEqual([]);
  });

  describe('FUNDING_DUE_SOON — pays the next event, ≤ 30 min away, saving ≥ 1 bp', () => {
    const due = (minutes: number, rate = 0.0001, side: 'long' | 'short' = 'long') =>
      judge([venue({ funding: { rate, intervalHours: 8, intervalBasis: 'contract', nextFundingTime: NOW + minutes * MIN } })], { holdHours: 4, side });
    it(`${FUNDING_SOON_MINUTES} minutes exactly: flagged`, () => {
      const d = due(30);
      expect(codes(d)).toEqual(['FUNDING_DUE_SOON']);
      expect(d.timing).toEqual({ exchange: 'BINANCE', nextFundingAtMs: NOW + 30 * MIN, minutesToNextFunding: 30, sidePaysNextFunding: true, savingBpsIfEnteredAfterNextFunding: 1 });
    });
    it('30.1 minutes: not flagged', () => expect(codes(due(30.1))).toEqual([]));
    it(`saving of exactly ${MIN_TIMING_SAVING_BPS} bp flags; just under does not`, () => {
      expect(codes(due(10, 0.0001))).toEqual(['FUNDING_DUE_SOON']);
      expect(codes(due(10, 0.0000999))).toEqual([]);
    });
    it('a side that receives the next funding is never told to wait', () => {
      const d = due(10, 0.0001, 'short');
      expect(codes(d)).toEqual(['FUNDING_INCOME']);
      expect(d.timing?.sidePaysNextFunding).toBe(false);
    });
    it('a whole-interval hold saves nothing, so it is not flagged', () => {
      const d = judge([venue({ funding: { rate: 0.0001, intervalHours: 8, intervalBasis: 'contract', nextFundingTime: NOW + 10 * MIN } })], { holdHours: 8 });
      expect(d.timing?.savingBpsIfEnteredAfterNextFunding).toBe(0);
      expect(codes(d)).toEqual([]);
    });
  });

  describe('regime', () => {
    const at = (label: string, confidence: number, side: 'long' | 'short' = 'long') =>
      codes(judge([venue()], { side, regime: { label, confidence, timeframe: '4h', asOfMs: NOW, sourceExchange: 'BINANCE' } satisfies RegimeRead }));
    it(`REGIME_AGAINST_SIDE from ${REGIME_AGAINST_MIN_CONFIDENCE}: long in TRENDING_DOWN, short in TRENDING_UP`, () => {
      expect(at('TRENDING_DOWN', 60)).toEqual(['REGIME_AGAINST_SIDE']);
      expect(at('TRENDING_DOWN', 59)).toEqual([]);
      expect(at('TRENDING_UP', 60, 'short')).toEqual(['REGIME_AGAINST_SIDE', 'FUNDING_INCOME']);
      expect(at('TRENDING_UP', 99)).toEqual([]);
      expect(at('TRENDING_DOWN', 99, 'short')).toEqual(['FUNDING_INCOME']);
    });
    it(`REGIME_VOLATILE from ${VOLATILE_MIN_CONFIDENCE}`, () => {
      expect(at('VOLATILE', 70)).toEqual(['REGIME_VOLATILE']);
      expect(at('VOLATILE', 69)).toEqual([]);
    });
    it('REGIME_UNAVAILABLE is info only: GO stays GO', () => {
      const d = judge([venue()], { regime: null });
      expect(codes(d)).toEqual(['REGIME_UNAVAILABLE']);
      expect(d.decision).toBe('GO');
    });
  });

  it('UNDERLYING_CLOSED adjusts', () => {
    const d = judge([venue()], { underlyingClosed: true });
    expect(codes(d)).toEqual(['UNDERLYING_CLOSED']);
    expect(d.decision).toBe('CAUTION');
  });

  it('VENUES_UNAVAILABLE / NEXT_FUNDING_UNKNOWN / FUNDING_INCOME / FEE_TABLE_STALE are info only', () => {
    const d = judge(
      [venue({ funding: { rate: 0.0001, intervalHours: 8, intervalBasis: 'declared', nextFundingTime: null } }), venue({ exchange: 'OKX', universeOk: false, asset: null })],
      { side: 'short', staleFees: [{ exchange: 'BINANCE', verifiedAt: '2026-01-01' }] },
    );
    expect(codes(d)).toEqual(['VENUES_UNAVAILABLE', 'NEXT_FUNDING_UNKNOWN', 'FUNDING_INCOME', 'FEE_TABLE_STALE']);
    expect(d.decision).toBe('GO');
    expect(d.timing).toMatchObject({ nextFundingAtMs: null, minutesToNextFunding: null, savingBpsIfEnteredAfterNextFunding: null });
  });

  it('any block → WAIT even beside adjusts; adjust → CAUTION', () => {
    const d = judge([venue({ asset: null, funding: null })], { underlyingClosed: true });
    expect(d.decision).toBe('WAIT');
    expect(codes(d)).toEqual(['NO_TRADABLE_VENUE', 'UNDERLYING_CLOSED']);
  });

  it('every detail is one plain sentence with no internal identifier', () => {
    const all = [
      judge([venue({ asset: { liquidityUsd: 10, volume24hUsd: 1e10 } }), venue({ exchange: 'OKX', universeOk: false, asset: null })], { underlyingClosed: true, regime: null }),
      judge([venue({ asset: { liquidityUsd: 5e8, volume24hUsd: 4_000_000 }, funding: { rate: 0.002, intervalHours: 8, intervalBasis: 'declared', nextFundingTime: null } })], { staleFees: [{ exchange: 'BINANCE', verifiedAt: '2026-01-01' }] }),
    ].flatMap((d) => d.reasons);
    expect(all.length).toBeGreaterThan(5);
    for (const r of all) {
      expect(r.detail).toMatch(/^[A-Z][^\n]*[.]$/);
      expect(r.detail).not.toMatch(/\b[a-z]+_[a-z_]+\b/); // no snake_case token (exclusion codes, field names)
      expect(r.detail).not.toMatch(/undefined|NaN|null/);
    }
  });
});
