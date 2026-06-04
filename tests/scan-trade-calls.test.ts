/**
 * SCAN-TRADE-CALLS-W1 C3 — scan_trade_calls tool wrapper + schema.
 *
 * Tests the public surface: zod schema bounds + defaults, multi-unit quota
 * charging (non-HOLD returned, HOLDs free), all-HOLD → 1 unit, includeHolds
 * rows don't charge, exhausted-tier entry block (no scan, no charge),
 * _algovault.tool, and forbidden-keys on the full serialized response.
 *
 * Universe is module-mocked; the scorer is injected via _setScanScorerForTest;
 * quota uses deterministic per-test tracker keys.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import type { ExchangeAsset } from '../src/lib/exchange-universe.js';
import type { LicenseInfo, SignalVerdict } from '../src/types.js';

vi.mock('../src/lib/exchange-universe.js', () => ({
  getExchangeTopAssetsWithVolume: vi.fn(),
}));

import { getExchangeTopAssetsWithVolume } from '../src/lib/exchange-universe.js';
import { _setScanScorerForTest, _clearScanCaches, type ScanScore } from '../src/lib/trade-call-scanner.js';
import { trackCallByKey } from '../src/lib/license.js';
import {
  runScanTradeCall,
  SCAN_TRADE_CALLS_SCHEMA,
  type ScanTradeCallsResponse,
  type ScanQuotaExhaustedResponse,
} from '../src/tools/scan-trade-calls.js';

const mockUniverse = vi.mocked(getExchangeTopAssetsWithVolume);
const SCHEMA = z.object(SCAN_TRADE_CALLS_SCHEMA);

function makeAssets(n: number): ExchangeAsset[] {
  return Array.from({ length: n }, (_, i) => ({
    coin: `COIN${i}`,
    notionalOI_usd: (n - i) * 1_000_000,
    volume24h_usd: (n - i) * 500_000,
  }));
}

type Verdict = { call: SignalVerdict; confidence: number };
function specScorer(spec: Record<string, Verdict>, calls?: { n: number }) {
  return async (coin: string, timeframe: string): Promise<ScanScore> => {
    if (calls) calls.n++;
    const v = spec[coin] ?? { call: 'HOLD' as const, confidence: 5 };
    return { coin, timeframe, call: v.call, confidence: v.confidence, regime: 'RANGING' };
  };
}

const starter = (key: string): LicenseInfo => ({ tier: 'starter', key, customerId: 'cus_test' });
function isExhausted(r: ScanTradeCallsResponse | ScanQuotaExhaustedResponse): r is ScanQuotaExhaustedResponse {
  return 'error' in r;
}

// 3 BUY + 2 SELL + (rest HOLD)
const SPEC: Record<string, Verdict> = {
  COIN0: { call: 'BUY', confidence: 90 },
  COIN1: { call: 'BUY', confidence: 80 },
  COIN2: { call: 'BUY', confidence: 70 },
  COIN3: { call: 'SELL', confidence: 60 },
  COIN4: { call: 'SELL', confidence: 50 },
};

beforeEach(() => {
  _clearScanCaches();
  _setScanScorerForTest(null);
  mockUniverse.mockReset();
  mockUniverse.mockImplementation((_ex, n: number) => Promise.resolve(makeAssets(n)));
});

describe('SCAN_TRADE_CALLS_SCHEMA bounds + defaults', () => {
  it('rejects topN 0 and 101', () => {
    expect(SCHEMA.safeParse({ topN: 0 }).success).toBe(false);
    expect(SCHEMA.safeParse({ topN: 101 }).success).toBe(false);
  });
  it('accepts topN 1 and 100', () => {
    expect(SCHEMA.safeParse({ topN: 1 }).success).toBe(true);
    expect(SCHEMA.safeParse({ topN: 100 }).success).toBe(true);
  });
  it('applies defaults', () => {
    const parsed = SCHEMA.parse({});
    expect(parsed).toMatchObject({ topN: 20, timeframe: '15m', exchange: 'BINANCE', includeHolds: false, limit: 10 });
  });
  it('rejects a shadow venue not in the promoted-5 enum', () => {
    expect(SCHEMA.safeParse({ exchange: 'ASTER' }).success).toBe(false);
  });
  it('rejects limit 101 and minConfidence 101', () => {
    expect(SCHEMA.safeParse({ limit: 101 }).success).toBe(false);
    expect(SCHEMA.safeParse({ minConfidence: 101 }).success).toBe(false);
  });
});

describe('runScanTradeCall — quota charging', () => {
  it('charges max(1, non-HOLD returned): 3 BUY + 2 SELL, limit 10 → 5 units', async () => {
    _setScanScorerForTest(specScorer(SPEC));
    const r = await runScanTradeCall({ topN: 100, timeframe: '15m', exchange: 'BINANCE', limit: 10 }, starter('scan-q-5'));
    expect(isExhausted(r)).toBe(false);
    if (isExhausted(r)) return;
    expect(r.eligible_non_hold).toBe(5);
    expect(r._algovault.quota.used).toBe(5);
    expect(r._algovault.tool).toBe('scan_trade_calls');
  });

  it('an all-HOLD scan charges exactly 1 unit', async () => {
    _setScanScorerForTest(specScorer({})); // every coin → HOLD
    const r = await runScanTradeCall({ topN: 50, timeframe: '15m', exchange: 'BINANCE', limit: 10 }, starter('scan-q-allhold'));
    if (isExhausted(r)) throw new Error('unexpected exhaustion');
    expect(r.eligible_non_hold).toBe(0);
    expect(r._algovault.quota.used).toBe(1); // max(1, 0)
    expect(r.calls).toHaveLength(0);
  });

  it('includeHolds rows do not add to the charge', async () => {
    _setScanScorerForTest(specScorer(SPEC));
    const r = await runScanTradeCall(
      { topN: 100, timeframe: '15m', exchange: 'BINANCE', includeHolds: true, limit: 10 },
      starter('scan-q-includeholds'),
    );
    if (isExhausted(r)) throw new Error('unexpected exhaustion');
    expect(r.calls.length).toBe(10); // 5 non-HOLD + 5 HOLD
    expect(r.eligible_non_hold).toBe(5); // HOLDs excluded from the charge
    expect(r._algovault.quota.used).toBe(5);
  });
});

describe('runScanTradeCall — exhausted-tier entry block', () => {
  it('a quota-exhausted free tier is blocked at entry: no scan, no charge', async () => {
    const calls = { n: 0 };
    _setScanScorerForTest(specScorer(SPEC, calls));
    // Exhaust the free meter (free key = `free:anon` under test — no request ctx).
    trackCallByKey('free:anon', 'free', 1000);
    const free: LicenseInfo = { tier: 'free', key: null };
    const r = await runScanTradeCall({ topN: 100, timeframe: '15m', exchange: 'BINANCE', limit: 10 }, free);
    expect(isExhausted(r)).toBe(true);
    if (!isExhausted(r)) return;
    expect(r.error).toBe('quota_exhausted');
    expect(r.message).toMatch(/Free tier limit reached/);
    expect(r.suggested_action).toBeTruthy();
    expect(calls.n).toBe(0); // scanner never ran
  });
});

describe('runScanTradeCall — response shape / forbidden keys', () => {
  it('serialized response has zero forbidden-key hits', async () => {
    _setScanScorerForTest(specScorer(SPEC));
    const r = await runScanTradeCall(
      { topN: 100, timeframe: '15m', exchange: 'BINANCE', includeHolds: true, limit: 100 },
      starter('scan-q-shape'),
    );
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/"(outcome_return_pct|outcome_price|price_at_signal)"\s*:/);
    expect(json).not.toMatch(/"(reasoning|indicators|price)"\s*:/);
    expect(json).toContain('"tool":"scan_trade_calls"'); // compact JSON.stringify (no spaces)
  });
});
