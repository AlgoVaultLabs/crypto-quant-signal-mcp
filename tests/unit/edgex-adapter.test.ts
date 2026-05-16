/**
 * PILOT-ADAPTERS-W1 / C2 — edgeX adapter unit tests.
 *
 * Mocks `globalThis.fetch`. Asserts:
 *   - contractName ↔ contractId lookup table builds from getMetaData.
 *   - getCandles routes via klineType + from/to ms params.
 *   - getAssetContext extracts all 5 capabilities from getTicker envelope.
 *   - Funding period × 2190 annualization (4h cadence per Plan-Mode probe).
 *   - getCurrentPrice extracts markPrice; null on unknown contract.
 *   - getFundingHistory filters records >= startTime.
 *   - 429 throws UpstreamRateLimitError with exchange="edgeX".
 *   - Unknown coin (not in contract map) returns empty/null/throws per method.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  EdgeXAdapter,
  toEdgeXContractId,
  fromEdgeXContractId,
  _resetEdgeXCacheForTest,
} from '../../src/lib/adapters/edgex.js';
import { UpstreamRateLimitError } from '../../src/lib/errors.js';

interface MockResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

let mockResponses: Map<string, MockResponse>;
let fetchCalls: { url: string }[];
let originalFetch: typeof fetch;

function setMock(urlSubstring: string, response: MockResponse): void {
  mockResponses.set(urlSubstring, response);
}

function buildFetchMock(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url });
    for (const [substr, resp] of mockResponses.entries()) {
      if (url.includes(substr)) {
        return {
          ok: (resp.status ?? 200) >= 200 && (resp.status ?? 200) < 300,
          status: resp.status ?? 200,
          statusText: resp.statusText ?? 'OK',
          headers: {
            get: (name: string) => resp.headers?.[name.toLowerCase()] ?? resp.headers?.[name] ?? null,
          },
          json: async () => resp.body,
          text: async () => JSON.stringify(resp.body),
        } as unknown as Response;
      }
    }
    throw new Error(`[mock-fetch] unhandled URL: ${url}`);
  }) as typeof fetch;
}

const META_FIXTURE = {
  code: 'SUCCESS',
  data: {
    contractList: [
      { contractId: '10000001', contractName: 'BTCUSD' },
      { contractId: '10000002', contractName: 'ETHUSD' },
      { contractId: '10000003', contractName: 'SOLUSD' },
    ],
  },
  msg: null,
  errorParam: null,
};

beforeEach(() => {
  mockResponses = new Map();
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = buildFetchMock();
  _resetEdgeXCacheForTest();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

// ── Contract lookup ──────────────────────────────────────────────────────

describe('toEdgeXContractId / fromEdgeXContractId — lookup map', () => {
  it('resolves BTC → 10000001 via getMetaData on first call', async () => {
    setMock('/api/v1/public/meta/getMetaData', { status: 200, body: META_FIXTURE });
    expect(await toEdgeXContractId('BTC')).toBe('10000001');
    expect(await toEdgeXContractId('ETH')).toBe('10000002');
    expect(await toEdgeXContractId('SOL')).toBe('10000003');
  });

  it('reverse-lookups contractId → canonical coin', async () => {
    setMock('/api/v1/public/meta/getMetaData', { status: 200, body: META_FIXTURE });
    expect(await fromEdgeXContractId('10000001')).toBe('BTC');
    expect(await fromEdgeXContractId('10000002')).toBe('ETH');
  });

  it('returns null for unknown coin (not throws)', async () => {
    setMock('/api/v1/public/meta/getMetaData', { status: 200, body: META_FIXTURE });
    expect(await toEdgeXContractId('UNKNOWN_COIN')).toBeNull();
  });

  it('caches the map on first fetch (single getMetaData call across many lookups)', async () => {
    setMock('/api/v1/public/meta/getMetaData', { status: 200, body: META_FIXTURE });
    await toEdgeXContractId('BTC');
    await toEdgeXContractId('ETH');
    await toEdgeXContractId('SOL');
    await toEdgeXContractId('NONEXISTENT');
    const metaCalls = fetchCalls.filter(c => c.url.includes('getMetaData'));
    expect(metaCalls.length).toBe(1);
  });

  it('upper-cases coin lookup (case-insensitive)', async () => {
    setMock('/api/v1/public/meta/getMetaData', { status: 200, body: META_FIXTURE });
    expect(await toEdgeXContractId('btc')).toBe('10000001');
    expect(await toEdgeXContractId('Btc')).toBe('10000001');
  });
});

// ── getCandles ───────────────────────────────────────────────────────────

describe('EdgeXAdapter.getCandles', () => {
  it('routes via numeric contractId + klineType map + from/to ms params', async () => {
    setMock('/api/v1/public/meta/getMetaData', { status: 200, body: META_FIXTURE });
    setMock('/api/v1/public/quote/getKline', {
      status: 200,
      body: {
        code: 'SUCCESS',
        data: {
          dataList: [
            { klineId: 'k1', klineTime: '1778907600000', open: '78999.3', high: '79001.6', low: '78899.2', close: '78990.0', size: '179.991', value: '14213635.1393', trades: '894' },
            { klineId: 'k2', klineTime: '1778904000000', open: '80000', high: '80100', low: '79900', close: '79950', size: '200', value: '16000000', trades: '500' },
          ],
        },
      },
    });
    const candles = await new EdgeXAdapter().getCandles('BTC', '1h', 1778900000000);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({
      time: 1778907600000,
      open: 78999.3,
      high: 79001.6,
      low: 78899.2,
      close: 78990,
      volume: 179.991,
    });
    const klineCall = fetchCalls.find(c => c.url.includes('getKline'));
    expect(klineCall?.url).toContain('contractId=10000001');
    expect(klineCall?.url).toContain('klineType=HOUR_1');
    expect(klineCall?.url).toContain('from=1778900000000');
  });

  it('maps every canonical timeframe to a SNAKE_UPPERCASE klineType', async () => {
    setMock('/api/v1/public/meta/getMetaData', { status: 200, body: META_FIXTURE });
    setMock('/api/v1/public/quote/getKline', { status: 200, body: { code: 'SUCCESS', data: { dataList: [] } } });
    const adapter = new EdgeXAdapter();
    const expected: [string, string][] = [
      ['1m', 'MINUTE_1'], ['3m', 'MINUTE_3'], ['5m', 'MINUTE_5'], ['15m', 'MINUTE_15'],
      ['30m', 'MINUTE_30'], ['1h', 'HOUR_1'], ['2h', 'HOUR_2'], ['4h', 'HOUR_4'],
      ['8h', 'HOUR_8'], ['12h', 'HOUR_12'], ['1d', 'DAY_1'],
    ];
    for (const [tf, klineType] of expected) {
      fetchCalls = [];
      await adapter.getCandles('BTC', tf, 1778900000000);
      const klineCall = fetchCalls.find(c => c.url.includes('getKline'));
      expect(klineCall?.url, `tf=${tf}`).toContain(`klineType=${klineType}`);
    }
  });

  it('returns [] when contractId is unknown (graceful, not throws)', async () => {
    setMock('/api/v1/public/meta/getMetaData', { status: 200, body: META_FIXTURE });
    const candles = await new EdgeXAdapter().getCandles('UNKNOWN', '1h', 0);
    expect(candles).toEqual([]);
  });
});

// ── getAssetContext ──────────────────────────────────────────────────────

describe('EdgeXAdapter.getAssetContext', () => {
  it('extracts all 5 capabilities from the getTicker envelope', async () => {
    setMock('/api/v1/public/meta/getMetaData', { status: 200, body: META_FIXTURE });
    setMock('/api/v1/public/quote/getTicker', {
      status: 200,
      body: {
        code: 'SUCCESS',
        data: [{
          contractId: '10000001',
          contractName: 'BTCUSD',
          lastPrice: '78379.6',
          indexPrice: '78411.30',
          oraclePrice: '78422.85',
          markPrice: '78422.85',
          openInterest: '4670.546',
          fundingRate: '0.00005000',
          fundingTime: '1778904000000',
          nextFundingTime: '1778918400000',
          size: '4273.107',
          value: '339486218.5566',
          open: '80542.6',
          high: '80957.0',
          low: '78375.4',
          close: '78379.6',
        }],
      },
    });
    const ctx = await new EdgeXAdapter().getAssetContext('BTC');
    expect(ctx.coin).toBe('BTC');
    expect(ctx.funding).toBeCloseTo(0.00005);
    // 4h funding cadence → annualize × 2190
    expect(ctx.fundingAnnualized).toBeCloseTo(0.00005 * 2190);
    expect(ctx.openInterest).toBeCloseTo(4670.546);
    expect(ctx.prevDayPx).toBeCloseTo(80542.6);
    expect(ctx.volume24h).toBeCloseTo(339486218.5566);
    expect(ctx.markPx).toBeCloseTo(78422.85);
    expect(ctx.oraclePx).toBeCloseTo(78422.85);
  });

  it('throws on unknown coin', async () => {
    setMock('/api/v1/public/meta/getMetaData', { status: 200, body: META_FIXTURE });
    await expect(new EdgeXAdapter().getAssetContext('UNKNOWN')).rejects.toThrow(/unknown contract/);
  });
});

// ── getCurrentPrice ──────────────────────────────────────────────────────

describe('EdgeXAdapter.getCurrentPrice', () => {
  it('returns markPrice for known coin', async () => {
    setMock('/api/v1/public/meta/getMetaData', { status: 200, body: META_FIXTURE });
    setMock('/api/v1/public/quote/getTicker', {
      status: 200,
      body: { code: 'SUCCESS', data: [{ contractId: '10000001', markPrice: '78422.85' }] },
    });
    expect(await new EdgeXAdapter().getCurrentPrice('BTC')).toBeCloseTo(78422.85);
  });

  it('returns null for unknown coin', async () => {
    setMock('/api/v1/public/meta/getMetaData', { status: 200, body: META_FIXTURE });
    expect(await new EdgeXAdapter().getCurrentPrice('UNKNOWN')).toBeNull();
  });
});

// ── getFundingHistory ────────────────────────────────────────────────────

describe('EdgeXAdapter.getFundingHistory', () => {
  it('filters records >= startTime', async () => {
    setMock('/api/v1/public/meta/getMetaData', { status: 200, body: META_FIXTURE });
    setMock('/api/v1/public/funding/getLatestFundingRate', {
      status: 200,
      body: {
        code: 'SUCCESS',
        data: [
          { contractId: '10000001', fundingTime: '1778900000000', fundingRate: '0.00005' },
          { contractId: '10000001', fundingTime: '1778903600000', fundingRate: '0.00006' },
          { contractId: '10000001', fundingTime: '1778800000000', fundingRate: '0.00003' }, // pre-window
        ],
      },
    });
    const records = await new EdgeXAdapter().getFundingHistory('BTC', 1778900000000);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ time: 1778900000000, fundingRate: 0.00005 });
  });

  it('returns [] (not throws) when contract is unknown', async () => {
    setMock('/api/v1/public/meta/getMetaData', { status: 200, body: META_FIXTURE });
    expect(await new EdgeXAdapter().getFundingHistory('UNKNOWN', 0)).toEqual([]);
  });
});

// ── Rate-limit error ─────────────────────────────────────────────────────

describe('EdgeXAdapter — 429 handling', () => {
  it('throws UpstreamRateLimitError with exchange="edgeX"', async () => {
    setMock('/api/v1/public/meta/getMetaData', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'Retry-After': '0' },
    });
    try {
      await new EdgeXAdapter().getCandles('BTC', '1h', 0);
      throw new Error('expected UpstreamRateLimitError');
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamRateLimitError);
      expect((err as UpstreamRateLimitError).exchange).toBe('edgeX');
    }
  }, 10000);
});

// ── Adapter identity ─────────────────────────────────────────────────────

describe('EdgeXAdapter.getName', () => {
  it('returns "edgeX" (presentational casing)', () => {
    expect(new EdgeXAdapter().getName()).toBe('edgeX');
  });
});
