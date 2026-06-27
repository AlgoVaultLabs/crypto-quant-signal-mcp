/**
 * SCAN-RANKBY-W1 CH1 — scanner threading + handler validation.
 *
 * Asserts: omitted/`oi` ⇒ byte-identical output (no rank fields); non-`oi` lenses
 * echo rank_value + the typed field; aliases resolve; an unknown token is lenient
 * (→ oi) in the engine but STRICTLY rejected by the handler; never any outcome_*.
 *
 * The universe selectors (getExchangeTopAssetsWithVolume for oi, getRankedUniverse
 * for lenses) are module-mocked; the scorer is injected. No live API is hit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExchangeAsset } from '../../src/lib/exchange-universe.js';
import type { RankedAsset } from '../../src/lib/rank-metrics.js';

vi.mock('../../src/lib/exchange-universe.js', () => ({
  getExchangeTopAssetsWithVolume: vi.fn(),
}));
vi.mock('../../src/lib/rank-metrics.js', () => ({
  getRankedUniverse: vi.fn(),
}));

import { getExchangeTopAssetsWithVolume } from '../../src/lib/exchange-universe.js';
import { getRankedUniverse } from '../../src/lib/rank-metrics.js';
import {
  scanTradeCalls,
  _setScanScorerForTest,
  _clearScanCaches,
  type ScanScore,
} from '../../src/lib/trade-call-scanner.js';

const mockTopAssets = vi.mocked(getExchangeTopAssetsWithVolume);
const mockRanked = vi.mocked(getRankedUniverse);

function assets(coins: string[]): ExchangeAsset[] {
  return coins.map((coin, i) => ({ coin, notionalOI_usd: (coins.length - i) * 1e6, volume24h_usd: 1e6 }));
}
const allBuyScorer = async (coin: string, timeframe: string): Promise<ScanScore> => ({
  coin,
  timeframe,
  call: 'BUY',
  confidence: 80,
  regime: 'TRENDING_UP',
});

beforeEach(() => {
  _clearScanCaches();
  _setScanScorerForTest(allBuyScorer);
  mockTopAssets.mockReset();
  mockRanked.mockReset();
});

const RANK_KEYS = ['rank_value', 'change_24h_pct', 'volume_24h', 'funding_rate', 'funding_apr'];

describe('byte-identity — omitted/oi lens', () => {
  it('omitted rankBy: output carries NO rank fields; uses the OI path', async () => {
    mockTopAssets.mockResolvedValue(assets(['BTC', 'ETH']));
    const r = await scanTradeCalls({ exchange: 'BYBIT', timeframe: '15m' });
    expect(r.calls.map((c) => c.coin).sort()).toEqual(['BTC', 'ETH']);
    for (const c of r.calls) {
      for (const k of RANK_KEYS) expect(c).not.toHaveProperty(k);
      expect(Object.keys(c).sort()).toEqual(['call', 'coin', 'confidence', 'exchange', 'regime', 'timeframe']);
    }
    expect(mockRanked).not.toHaveBeenCalled(); // oi never touches the rank selector
  });

  it('explicit rankBy:"oi" is also byte-identical (no echo)', async () => {
    mockTopAssets.mockResolvedValue(assets(['BTC']));
    const r = await scanTradeCalls({ exchange: 'BYBIT', rankBy: 'oi' });
    expect(r.calls[0]).not.toHaveProperty('rank_value');
    expect(mockRanked).not.toHaveBeenCalled();
  });
});

describe('non-oi lenses — rank echo threaded to output', () => {
  it('gainers: each call carries rank_value + change_24h_pct only', async () => {
    mockRanked.mockResolvedValue([
      { coin: 'SOL', rankBy: 'gainers', rank_value: 12, change_24h_pct: 12 },
      { coin: 'BTC', rankBy: 'gainers', rank_value: 1, change_24h_pct: 1 },
    ] as RankedAsset[]);
    const r = await scanTradeCalls({ exchange: 'BYBIT', rankBy: 'gainers' });
    const sol = r.calls.find((c) => c.coin === 'SOL')!;
    expect(sol.rank_value).toBe(12);
    expect(sol.change_24h_pct).toBe(12);
    expect(sol).not.toHaveProperty('funding_rate');
    expect(sol).not.toHaveProperty('volume_24h');
    expect(mockRanked).toHaveBeenCalledWith('BYBIT', 'gainers', 20);
  });

  it('funding_negative: carries funding_rate + funding_apr', async () => {
    mockRanked.mockResolvedValue([
      { coin: 'SOL', rankBy: 'funding_negative', rank_value: -0.0009, funding_rate: -0.0009, funding_apr: -0.985 },
    ] as RankedAsset[]);
    const r = await scanTradeCalls({ exchange: 'OKX', rankBy: 'funding_negative' });
    const sol = r.calls.find((c) => c.coin === 'SOL')!;
    expect(sol.funding_rate).toBe(-0.0009);
    expect(sol.funding_apr).toBeCloseTo(-0.985, 6);
    expect(sol).not.toHaveProperty('change_24h_pct');
  });

  it('alias "nfr" resolves to funding_negative before the selector call', async () => {
    mockRanked.mockResolvedValue([
      { coin: 'ETH', rankBy: 'funding_negative', rank_value: -0.001, funding_rate: -0.001, funding_apr: null },
    ] as RankedAsset[]);
    await scanTradeCalls({ exchange: 'BYBIT', rankBy: 'nfr', topN: 30 });
    expect(mockRanked).toHaveBeenCalledWith('BYBIT', 'funding_negative', 30);
  });

  it('unknown token is LENIENT in the engine (→ oi, no rank selector)', async () => {
    mockTopAssets.mockResolvedValue(assets(['BTC']));
    const r = await scanTradeCalls({ exchange: 'BYBIT', rankBy: 'garbage' });
    expect(r.calls[0]).not.toHaveProperty('rank_value');
    expect(mockRanked).not.toHaveBeenCalled();
    expect(mockTopAssets).toHaveBeenCalled();
  });

  it('serialized output never contains outcome_* (PII guard)', async () => {
    mockRanked.mockResolvedValue([
      { coin: 'SOL', rankBy: 'funding_negative', rank_value: -0.0009, funding_rate: -0.0009, funding_apr: -0.985 },
    ] as RankedAsset[]);
    const r = await scanTradeCalls({ exchange: 'OKX', rankBy: 'funding_negative' });
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/outcome_/);
  });
});
