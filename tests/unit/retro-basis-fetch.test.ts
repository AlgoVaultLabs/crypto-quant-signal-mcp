/**
 * tests/unit/retro-basis-fetch.test.ts — OPS-BASIS-RETRO-BACKFILL-W1
 *
 * The paged network fetcher `fetchBasisSeries` with the shared transport mocked: it must fetch the
 * mark series + the index series through `upstreamFetch` (batch lane), align them into basis rows,
 * bound the request to the [startMs, endMs] window, and TERMINATE (empty page ⇒ stop; never loops).
 * The per-venue pagination dialects are proven live by the R1 cross-check gate before any bulk write.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { upstreamFetch } = vi.hoisted(() => ({ upstreamFetch: vi.fn() }));
vi.mock('../../src/lib/adapters/_upstream-fetch.js', () => ({
  upstreamFetch,
  // each VENUE_FETCH_CONFIGS.<V> resolves to a stub carrying its venue name
  VENUE_FETCH_CONFIGS: new Proxy({} as Record<string, { venue: string }>, {
    get: (_t, k) => ({ venue: String(k) }),
  }),
}));

import { fetchBasisSeries } from '../../src/lib/retro-basis-sources.js';

const BINANCE_MARK = JSON.parse(
  '[[1784901600000,"64112.6","64172.0","63715.2","64031.4","0",1784905199999,"0",3600,"0","0","0"],[1784905200000,"64032.1","64165.5","63827.5","64100.9","0",1784908799999,"0",1056,"0","0","0"]]',
);
const BINANCE_INDEX = JSON.parse(
  '[[1784901600000,"64139.8","64196.1","63741.9","64050.4","0",1784905199999,"0",3600,"0","0","0"],[1784905200000,"64050.7","64191.3","63859.1","64132.6","0",1784908799999,"0",1056,"0","0","0"]]',
);

const START = 1784901600000;
const END = 1784905200000; // tight window: both fixture bars, one forward page, then stop

describe('fetchBasisSeries (BINANCE — orchestration)', () => {
  // Block body — an expression-body arrow would RETURN mockReset()'s value (the mock), which vitest
  // registers as a teardown callback and later invokes with 0 args (skill: vitest-hook-returning-a-value).
  beforeEach(() => {
    upstreamFetch.mockReset();
  });

  it('fetches mark + index through upstreamFetch (batch lane) and aligns them into basis rows', async () => {
    let markServed = false;
    let indexServed = false;
    upstreamFetch.mockImplementation(async (_cfg: unknown, req: { url: string }) => {
      if (req.url.includes('markPriceKlines') && !markServed) {
        markServed = true;
        return BINANCE_MARK;
      }
      if (req.url.includes('indexPriceKlines') && !indexServed) {
        indexServed = true;
        return BINANCE_INDEX;
      }
      return []; // empty page ⇒ pagination terminates
    });

    const rows = await fetchBasisSeries('BINANCE', 'BTC', START, END);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ts: START, mark: 64031.4, index: 64050.4 });
    expect(rows[1].ts).toBe(END);
    // every call is in the batch lane
    for (const [, req] of upstreamFetch.mock.calls) expect((req as { cls?: string }).cls).toBe('batch');
  });

  it('builds the venue-native URLs (mark symbol= / index pair=)', async () => {
    upstreamFetch.mockResolvedValue([]);
    await fetchBasisSeries('BINANCE', 'BTC', START, END);
    const urls = upstreamFetch.mock.calls.map(([, req]) => (req as { url: string }).url);
    expect(urls.some((u) => u.includes('markPriceKlines') && u.includes('symbol=BTCUSDT'))).toBe(true);
    expect(urls.some((u) => u.includes('indexPriceKlines') && u.includes('pair=BTCUSDT'))).toBe(true);
  });

  it('returns [] and never throws when the venue serves nothing', async () => {
    upstreamFetch.mockResolvedValue([]);
    await expect(fetchBasisSeries('BINANCE', 'BTC', START, END)).resolves.toEqual([]);
  });
});

describe('fetchBasisSeries — per-venue symbol/endpoint wiring', () => {
  beforeEach(() => {
    upstreamFetch.mockReset();
    upstreamFetch.mockResolvedValue([]);
  });

  it('OKX uses history-*-candles with the SWAP mark instId and the spot index instId', async () => {
    await fetchBasisSeries('OKX', 'BTC', START, END);
    const urls = upstreamFetch.mock.calls.map(([, req]) => (req as { url: string }).url);
    expect(urls.some((u) => u.includes('history-mark-price-candles') && u.includes('BTC-USDT-SWAP'))).toBe(true);
    expect(urls.some((u) => u.includes('history-index-candles') && u.includes('instId=BTC-USDT&'))).toBe(true);
  });

  it('GATE uses the mark_/index_ prefixed contracts', async () => {
    await fetchBasisSeries('GATE', 'SOL', START, END);
    const urls = upstreamFetch.mock.calls.map(([, req]) => (req as { url: string }).url);
    expect(urls.some((u) => u.includes('contract=mark_SOL_USDT'))).toBe(true);
    expect(urls.some((u) => u.includes('contract=index_SOL_USDT'))).toBe(true);
  });
});
