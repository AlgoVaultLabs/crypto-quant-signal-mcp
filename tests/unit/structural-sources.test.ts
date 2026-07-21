/**
 * tests/unit/structural-sources.test.ts — OPS-STRUCTURAL-FEATURE-ACCRUAL-W1
 *
 * The gap-closing HTTP layer for mark/index/bid/ask. `upstreamFetch` is mocked, so what is under
 * test is the part that actually diverges per venue and where a silent bug would hide: the
 * SYMBOL→coin mapping (each venue names the same coin differently) and the fail-soft contract
 * (one dead endpoint must not cost us the fields the other call already returned).
 *
 * Response SHAPES here are verbatim from the live census in
 * audits/OPS-STRUCTURAL-FEATURE-ACCRUAL-W1-endpoint-truth.md §2 (probed host-side 2026-07-21).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { upstreamFetch } = vi.hoisted(() => ({ upstreamFetch: vi.fn() }));
vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => {
  const actual = await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>();
  return { ...actual, upstreamFetch };
});

import { fetchStructuralGaps, STRUCTURAL_INLINE_VENUES } from '../../src/lib/structural-sources.js';

/** Route each mocked call by URL so a venue's two gap calls can return different payloads. */
function routeByUrl(routes: Record<string, unknown>): void {
  upstreamFetch.mockImplementation(async (_cfg: unknown, req: { url: string }) => {
    for (const [frag, payload] of Object.entries(routes)) {
      if (req.url.includes(frag)) {
        if (payload instanceof Error) throw payload;
        return payload;
      }
    }
    throw new Error(`unmocked url: ${req.url}`);
  });
}

// NB braces are load-bearing: `mockReset()` returns the mock, and vitest treats a function
// RETURNED from beforeEach as a cleanup hook — it would call the mock with zero args at teardown,
// producing an unhandled rejection attributed to whichever test just ran.
beforeEach(() => {
  upstreamFetch.mockReset();
});

describe('fetchStructuralGaps — inline venues cost ZERO extra calls', () => {
  it.each([...STRUCTURAL_INLINE_VENUES])('%s issues no gap call', async (venue) => {
    const m = await fetchStructuralGaps(venue);
    expect(m.size).toBe(0);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('an unknown / shadow venue is a no-op, not a throw', async () => {
    await expect(fetchStructuralGaps('WEEX')).resolves.toEqual(new Map());
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

describe('fetchStructuralGaps — per-venue symbol mapping', () => {
  it('BINANCE merges premiumIndex (mark+index) with bookTicker (bid+ask) and applies 1000× overrides', async () => {
    routeByUrl({
      premiumIndex: [
        { symbol: 'BTCUSDT', markPrice: '66200.1', indexPrice: '66229.3' },
        { symbol: '1000PEPEUSDT', markPrice: '0.0102', indexPrice: '0.0101' },
        { symbol: 'BTCUSDC', markPrice: '1', indexPrice: '1' }, // non-USDT → ignored
      ],
      bookTicker: [
        { symbol: 'BTCUSDT', bidPrice: '66200.0', askPrice: '66200.2' },
      ],
    });
    const m = await fetchStructuralGaps('BINANCE');
    expect(m.get('BTC')).toEqual({ markPx: 66200.1, indexPx: 66229.3, bidPx: 66200.0, askPx: 66200.2 });
    // 1000PEPE → PEPE, matching the coin the signal engine + universe use.
    expect(m.get('PEPE')?.markPx).toBe(0.0102);
    expect(m.has('BTCUSDC')).toBe(false);
  });

  it('OKX maps swap instIds for mark and SPOT instIds for index onto the same coin', async () => {
    routeByUrl({
      'public/mark-price': { data: [{ instId: 'BTC-USDT-SWAP', markPx: '66200.1' }] },
      'index-tickers': { data: [{ instId: 'BTC-USDT', idxPx: '66229.3' }] },
    });
    const m = await fetchStructuralGaps('OKX');
    expect(m.get('BTC')).toEqual({ markPx: 66200.1, indexPx: 66229.3, bidPx: undefined, askPx: undefined });
  });

  it('KUCOIN strips the "USDTM" suffix and maps XBT → BTC', async () => {
    routeByUrl({
      allTickers: {
        data: [
          { symbol: 'XBTUSDTM', bestBidPrice: '66200.0', bestAskPrice: '66200.5' },
          { symbol: 'ANIMEUSDTM', bestBidPrice: '0.002714', bestAskPrice: '0.002719' },
          { symbol: 'XBTUSDM', bestBidPrice: '1', bestAskPrice: '2' }, // inverse contract → ignored
        ],
      },
    });
    const m = await fetchStructuralGaps('KUCOIN');
    expect(m.get('BTC')).toMatchObject({ bidPx: 66200.0, askPx: 66200.5 });
    expect(m.get('ANIME')).toMatchObject({ bidPx: 0.002714 });
    expect(m.size).toBe(2);
  });

  it('HTX returns index only — no bulk mark endpoint exists, so markPx stays undefined', async () => {
    routeByUrl({ swap_index: { data: [{ contract_code: 'BTC-USDT', index_price: 66196.46 }] } });
    const m = await fetchStructuralGaps('HTX');
    expect(m.get('BTC')).toEqual({ markPx: undefined, indexPx: 66196.46, bidPx: undefined, askPx: undefined });
  });

  it('PHEMEX reads the v3 book fields the universe’s v2 call lacks', async () => {
    routeByUrl({ 'md/v3/ticker': { result: [{ symbol: 'BTCUSDT', bidRp: '66200', askRp: '66201' }] } });
    const m = await fetchStructuralGaps('PHEMEX');
    expect(m.get('BTC')).toMatchObject({ bidPx: 66200, askPx: 66201 });
  });

  it('BINGX strips the "-USDT" suffix on premiumIndex', async () => {
    routeByUrl({ premiumIndex: { data: [{ symbol: 'BTC-USDT', markPrice: '66200.1', indexPrice: '66229.3' }] } });
    const m = await fetchStructuralGaps('BINGX');
    expect(m.get('BTC')).toMatchObject({ markPx: 66200.1, indexPx: 66229.3 });
  });
});

describe('fetchStructuralGaps — fail-soft contract', () => {
  it('a dead bookTicker never costs the mark/index that premiumIndex already returned', async () => {
    routeByUrl({
      premiumIndex: [{ symbol: 'BTCUSDT', markPrice: '66200.1', indexPrice: '66229.3' }],
      bookTicker: new Error('429 rate limited'),
    });
    const m = await fetchStructuralGaps('BINANCE');
    expect(m.get('BTC')).toMatchObject({ markPx: 66200.1, indexPx: 66229.3 });
    expect(m.get('BTC')?.bidPx).toBeUndefined();
  });

  it('both calls failing degrades to an empty map — never a throw into the sampler', async () => {
    routeByUrl({ premiumIndex: new Error('boom'), bookTicker: new Error('boom') });
    await expect(fetchStructuralGaps('BINANCE')).resolves.toEqual(new Map());
  });

  it('junk / non-positive values are dropped rather than recorded as 0', async () => {
    routeByUrl({
      premiumIndex: [
        { symbol: 'AUSDT', markPrice: '0', indexPrice: 'abc' },
        { symbol: 'BUSDT', markPrice: '-1', indexPrice: '100' },
      ],
      bookTicker: [],
    });
    const m = await fetchStructuralGaps('BINANCE');
    expect(m.get('A')).toEqual({ markPx: undefined, indexPx: undefined, bidPx: undefined, askPx: undefined });
    expect(m.get('B')?.markPx).toBeUndefined();
    expect(m.get('B')?.indexPx).toBe(100); // the good half of the row survives
  });
});
