/**
 * tests/unit/retro-basis-sources.test.ts — OPS-BASIS-RETRO-BACKFILL-W1
 *
 * The PURE reconstruction core: per-venue mark/index kline PARSERS (fixtures are REAL responses
 * captured host-side 2026-07-24), the mark×index → basis alignment, and the venue kline-symbol
 * derivation. The network fetchers (paged upstreamFetch) are asserted separately with the transport
 * mocked; here we lock the shapes that would silently drift if a venue changed its payload.
 */

import { describe, it, expect } from 'vitest';
import {
  parseKlines,
  alignBasis,
  venueKlineSymbols,
  planRetroFetch,
  buildBinanceLikeSymbolMap,
  RECONSTRUCT_VENUES,
  type ReconstructVenue,
} from '../../src/lib/retro-basis-sources.js';

// ── REAL captured fixtures (limit=2/3, BTC, 1h), verbatim from the venue endpoints ──
const FIX: Record<string, unknown> = {
  BINANCE: JSON.parse(
    '[[1784901600000,"64112.60000000","64172.01528986","63715.27710145","64031.40000000","0",1784905199999,"0",3600,"0","0","0"],[1784905200000,"64032.10000000","64165.50000000","63827.55447826","64100.92660145","0",1784908799999,"0",1056,"0","0","0"]]',
  ),
  ASTER: JSON.parse(
    '[[1784901600000,"64102.50000000","64172.93396377","63719.58897463","64031.30000000","0",1784905199999,"0",3600,"0","0","0"],[1784905200000,"64031.30000000","64149.90000000","63831.89342029","64149.90000000","0",1784908799999,"0",992,"0","0","0"]]',
  ),
  BYBIT: JSON.parse(
    '{"retCode":0,"retMsg":"OK","result":{"symbol":"BTCUSDT","category":"linear","list":[["1784905200000","64026.7","64165.9","63821.02","64051.35"],["1784901600000","64121.9","64170","63705.7","64026.7"]]},"retExtInfo":{},"time":1784906263456}',
  ),
  OKX: JSON.parse(
    '{"code":"0","msg":"","data":[["1784905200000","64032.4","64168.1","63824.1","64065","0"],["1784901600000","64124.3","64174.1","63707.3","64032.4","1"]]}',
  ),
  BITGET: JSON.parse(
    '{"code":"00000","msg":"success","requestTime":1784906264741,"data":[["1784898000000","64749.2","64775","63894.8","64134.6","0","0"],["1784901600000","64134.6","64182.4","63720.3","64044.2","0","0"]]}',
  ),
  GATE: JSON.parse(
    '[{"o":"64125.6","v":0,"t":1784901600,"c":"64034.9","l":"63712.4","h":"64176","sum":"0"},{"o":"64032.8","v":0,"t":1784905200,"c":"64059.54","l":"63829.46","h":"64167.5","sum":"0"}]',
  ),
  MEXC: JSON.parse(
    '{"success":true,"code":0,"data":{"time":[1784898000,1784901600,1784905200],"open":[64746.6,64131.4,64030.5],"close":[64131.4,64030.5,64049.3],"high":[64774.5,64172.0,64160.9],"low":[63888.3,63716.5,63828.1],"vol":[0.0,0.0,0.0]}}',
  ),
};

describe('RECONSTRUCT_VENUES', () => {
  it('is exactly the 7 venues probed to serve deep mark+index klines', () => {
    expect([...RECONSTRUCT_VENUES].sort()).toEqual(
      ['ASTER', 'BINANCE', 'BITGET', 'BYBIT', 'GATE', 'MEXC', 'OKX'].sort(),
    );
  });
});

describe('parseKlines — per-venue shape → normalized {ts(ms, hour-floored), price(close)} ASC', () => {
  const expectedTail: Record<string, { ts: number; price: number }> = {
    // every venue's window includes the 1784901600000 bar; assert its CLOSE is picked
    BINANCE: { ts: 1784901600000, price: 64031.4 },
    ASTER: { ts: 1784901600000, price: 64031.3 },
    BYBIT: { ts: 1784901600000, price: 64026.7 },
    OKX: { ts: 1784901600000, price: 64032.4 },
    BITGET: { ts: 1784901600000, price: 64044.2 },
    GATE: { ts: 1784901600000, price: 64034.9 },
    MEXC: { ts: 1784901600000, price: 64030.5 },
  };
  for (const v of Object.keys(FIX) as ReconstructVenue[]) {
    it(`${v}: parses close prices, sorts ASC, floors ts to the hour`, () => {
      const bars = parseKlines(v, FIX[v]);
      expect(bars.length).toBeGreaterThanOrEqual(2);
      // strictly ascending, all hour-aligned, all strictly-positive
      for (let i = 1; i < bars.length; i++) expect(bars[i].ts).toBeGreaterThan(bars[i - 1].ts);
      for (const b of bars) {
        expect(b.ts % 3_600_000).toBe(0);
        expect(b.price).toBeGreaterThan(0);
      }
      const bar = bars.find((b) => b.ts === expectedTail[v].ts)!;
      expect(bar).toBeDefined();
      expect(bar.price).toBeCloseTo(expectedTail[v].price, 4);
    });
  }

  it('drops non-finite/non-positive prices and tolerates an empty payload', () => {
    expect(parseKlines('BINANCE', [])).toEqual([]);
    expect(parseKlines('OKX', { code: '0', data: [] })).toEqual([]);
    expect(parseKlines('MEXC', { success: true, data: { time: [], close: [] } })).toEqual([]);
    // a garbage row (price 0) is dropped, the good one kept
    const bars = parseKlines('BINANCE', [
      [1784901600000, '0', '0', '0', '0', '0'],
      [1784905200000, '1', '1', '1', '64100.9', '0'],
    ]);
    expect(bars).toEqual([{ ts: 1784905200000, price: 64100.9 }]);
  });
});

describe('alignBasis — inner-join mark×index by hour; both sides required', () => {
  it('emits a row only where BOTH mark and index exist for the same ts', () => {
    const mark = [
      { ts: 1000, price: 101 },
      { ts: 2000, price: 102 }, // no index @2000 → dropped
      { ts: 3000, price: 103 },
    ];
    const index = [
      { ts: 1000, price: 100 },
      { ts: 3000, price: 100 },
      { ts: 4000, price: 100 }, // no mark @4000 → dropped
    ];
    expect(alignBasis(mark, index)).toEqual([
      { ts: 1000, mark: 101, index: 100 },
      { ts: 3000, mark: 103, index: 100 },
    ]);
  });

  it('returns empty when there is no ts overlap', () => {
    expect(alignBasis([{ ts: 1, price: 1 }], [{ ts: 2, price: 1 }])).toEqual([]);
  });
});

describe('venueKlineSymbols — per-venue mark/index symbol conventions', () => {
  it('derives the deterministic 5 venues from the bare coin', () => {
    expect(venueKlineSymbols('BYBIT', 'BTC')).toEqual({ markSym: 'BTCUSDT', indexSym: 'BTCUSDT' });
    expect(venueKlineSymbols('BITGET', 'ETH')).toEqual({ markSym: 'ETHUSDT', indexSym: 'ETHUSDT' });
    expect(venueKlineSymbols('OKX', 'BTC')).toEqual({ markSym: 'BTC-USDT-SWAP', indexSym: 'BTC-USDT' });
    expect(venueKlineSymbols('GATE', 'SOL')).toEqual({ markSym: 'mark_SOL_USDT', indexSym: 'index_SOL_USDT' });
    expect(venueKlineSymbols('MEXC', 'BTC')).toEqual({ markSym: 'BTC_USDT', indexSym: 'BTC_USDT' });
  });

  it('BINANCE/ASTER default to <coin>USDT but honor a resolved venue symbol (1000× memes)', () => {
    expect(venueKlineSymbols('BINANCE', 'BTC')).toEqual({ markSym: 'BTCUSDT', indexSym: 'BTCUSDT' });
    // PEPE lists as 1000PEPEUSDT on Binance — the resolver passes the real venue symbol through
    expect(venueKlineSymbols('BINANCE', 'PEPE', '1000PEPEUSDT')).toEqual({
      markSym: '1000PEPEUSDT',
      indexSym: '1000PEPEUSDT',
    });
    expect(venueKlineSymbols('ASTER', 'BTC')).toEqual({ markSym: 'BTCUSDT', indexSym: 'BTCUSDT' });
  });
});

describe('planRetroFetch — DB-as-checkpoint fetch-range planning (idempotent + resumable)', () => {
  const START = 1_700_000_000_000;
  const END = 1_784_900_000_000;
  const BAR = 3_600_000;

  it('first run (no rows yet) fetches the whole [start, end]', () => {
    expect(planRetroFetch(null, START, END)).toEqual({ done: false, fetchStartMs: START, fetchEndMs: END });
  });

  it('resume run fetches OLDER-than the deepest existing retro ts', () => {
    const deepest = START + 100 * BAR;
    expect(planRetroFetch(deepest, START, END)).toEqual({ done: false, fetchStartMs: START, fetchEndMs: deepest });
  });

  it('is DONE once the deepest retro ts has reached the floor', () => {
    expect(planRetroFetch(START, START, END).done).toBe(true);
    expect(planRetroFetch(START - BAR, START, END).done).toBe(true); // reached past the floor
  });
});

describe('buildBinanceLikeSymbolMap — coin → venue kline symbol (1000× memes resolved)', () => {
  const norm = (c: string) => (c === '1000PEPE' ? 'PEPE' : c); // stub of normalizeBinanceCoin
  it('maps USDT PERPETUALs by normalized coin, keeping the real venue symbol', () => {
    const info = {
      symbols: [
        { symbol: 'BTCUSDT', contractType: 'PERPETUAL', status: 'TRADING' },
        { symbol: '1000PEPEUSDT', contractType: 'PERPETUAL', status: 'TRADING' },
        { symbol: 'ETHUSDC', contractType: 'PERPETUAL', status: 'TRADING' }, // non-USDT → skip
        { symbol: 'BTCUSDT_240927', contractType: 'CURRENT_QUARTER', status: 'TRADING' }, // dated → skip
      ],
    };
    const m = buildBinanceLikeSymbolMap(info, norm);
    expect(m.get('BTC')).toBe('BTCUSDT');
    expect(m.get('PEPE')).toBe('1000PEPEUSDT');
    expect(m.has('ETH')).toBe(false);
    expect(m.size).toBe(2);
  });

  it('tolerates a malformed payload', () => {
    expect(buildBinanceLikeSymbolMap(null, norm).size).toBe(0);
    expect(buildBinanceLikeSymbolMap({ symbols: 'nope' }, norm).size).toBe(0);
  });
});
