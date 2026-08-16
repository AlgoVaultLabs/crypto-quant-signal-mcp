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
import { trackCallByKey, requestContext } from '../src/lib/license.js';
import {
  runScanTradeCall,
  SCAN_TRADE_CALLS_SCHEMA,
  type ScanTradeCallsResponse,
  type ScanQuotaExhaustedResponse,
} from '../src/tools/scan-trade-calls.js';
import { PROMOTED_VENUE_IDS } from '../src/lib/capabilities.js';
import { FREE_MONTHLY_CALLS } from '../src/lib/plans.js';

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

describe('rankBy — schema + handler validation (SCAN-RANKBY-W1)', () => {
  it('schema: rankBy defaults to "oi" and forwards a raw string token', () => {
    expect(SCHEMA.parse({}).rankBy).toBe('oi'); // omitted ⇒ default
    expect(SCHEMA.parse({ rankBy: 'nfr' }).rankBy).toBe('nfr'); // raw (MCP resolves the alias)
  });

  it('handler rejects an unknown lens with invalid_rank_by — no scan, no charge', async () => {
    const calls = { n: 0 };
    _setScanScorerForTest(specScorer(SPEC, calls));
    const r = await runScanTradeCall({ exchange: 'BINANCE', rankBy: 'garbage' }, starter('av_badrank'));
    expect('error' in r).toBe(true);
    const err = r as unknown as { error: string; code: string; valid_lenses: string[] };
    expect(err.error).toBe('invalid_rank_by');
    expect(err.code).toBe('invalid_parameter');
    expect(err.valid_lenses).toContain('funding_negative');
    expect(err.valid_lenses).toContain('nfr');
    expect(calls.n).toBe(0); // rejected BEFORE any scan → nothing charged
  });
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
  it('accepts every promoted venue (enum derived from EXCHANGES) + rejects a non-promoted shadow venue', () => {
    // OPS-SCAN-UNIVERSE-EXPAND-W1: the exchange enum is now the 12 promoted venues (was the 5); ASTER
    // et al. are accepted. A configured-but-shadow ExchangeId (EDGEX) is still rejected at the boundary.
    for (const v of PROMOTED_VENUE_IDS) {
      expect(SCHEMA.safeParse({ exchange: v }).success).toBe(true);
    }
    expect(SCHEMA.safeParse({ exchange: 'EDGEX' }).success).toBe(false);
    expect(SCHEMA.safeParse({ exchange: 'NOPE' }).success).toBe(false);
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

  it('includeHolds rows DO add to the charge — you pay for the verdicts you receive (R-G)', async () => {
    // PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1: charging only the non-HOLD rows made a scan the
    // free-HOLD loophole that re-opens everything R-A closes — ask for 10 verdicts, pay for 5.
    // Note the symmetry this preserves: a DEFAULT scan omits HOLD rows from `calls`, so it is
    // unaffected. You are charged for what you are handed, which is why `includeHolds` is the
    // only shape whose price moves.
    _setScanScorerForTest(specScorer(SPEC));
    const r = await runScanTradeCall(
      { topN: 100, timeframe: '15m', exchange: 'BINANCE', includeHolds: true, limit: 10 },
      starter('scan-q-includeholds'),
    );
    if (isExhausted(r)) throw new Error('unexpected exhaustion');
    expect(r.calls.length).toBe(10); // 5 non-HOLD + 5 HOLD
    expect(r.eligible_non_hold).toBe(5); // still reported — it is a RESULT field, not the price
    expect(r._algovault.quota.used).toBe(10); // charged per returned verdict
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
    // OPS-QUOTA-EXHAUSTION-NOTICE-W1: the scan wall renders the ONE notice contract, and its
    // `code` is now the SAME `TIER_LIMIT_REACHED` every other surface emits (it was lowercase
    // `tier_limit_reached` here, so an agent needed two branches for one event). `error` keeps
    // its original lowercase value, which is what a pre-wave consumer matched on.
    expect(r.code).toBe('TIER_LIMIT_REACHED');
    expect(r.message).toContain(`Free monthly quota used: 1000/${FREE_MONTHLY_CALLS}`);
    expect(r.message).toMatch(/Access returns \d{4}-\d{2}-\d{2} \(\d+ days\)/);
    expect(r.resets_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.usage_display).toBe(`1000/${FREE_MONTHLY_CALLS}`);
    expect(r.quota.resets_at).toBe(r.resets_at);
    // REFERRAL-INPRODUCT-NUDGE-W1: the wall keeps the referral arm (keyless here → the
    // get-your-link path) + the structured referral_hint.
    expect(r.message.toLowerCase()).toContain('refer a friend');
    expect(r.message).toContain('Claim a free key — one call, no email. Your usage carries over, so nothing resets.'); // QCA-R2 CH2: the claim offer replaced the signup ask
    expect(r.message).not.toContain('unlimited');
    expect(r.referral_hint.from).toBe('limit');
    expect(r.referral_hint.link_or_path).toContain('upgrade_from=limit_referral');
    expect(r.suggested_action).toBeTruthy();
    // The hardcoded UPGRADE_HINT promised x402 unconditionally; with no live rail in this
    // env the offer must be absent from BOTH the prose and the action.
    expect(r.suggested_action).not.toContain('x402');
    expect(r.message).not.toContain('x402');
    expect(calls.n).toBe(0); // scanner never ran
  });
});

describe('runScanTradeCall — trigger (b) multi-hit-scan referral (REFERRAL-INPRODUCT-NUDGE-W1)', () => {
  it('KEYED + session + ≥3 non-HOLD → aha_scan referral hint (human + structured)', async () => {
    _setScanScorerForTest(specScorer(SPEC)); // SPEC = 5 non-HOLD
    const r = await requestContext.run(
      { license: starter('scan-ref-b'), sessionId: 'sess-scan-b', ipHash: null },
      () => runScanTradeCall({ topN: 100, timeframe: '15m', exchange: 'BINANCE', limit: 10 }, starter('scan-ref-b')),
    );
    if (isExhausted(r)) throw new Error('unexpected exhaustion');
    expect(r.eligible_non_hold).toBe(5);
    expect(r._algovault.referral_hint?.from).toBe('aha_scan');
    expect(r._algovault.referral_hint?.bonus_calls).toBe(500);
    expect(r._algovault.upgrade_hint).toContain('Your scan surfaced 5 live calls');
    expect(r._algovault.upgrade_hint).toContain('join?ref='); // keyed give-get link
  });

  it('below the multi-hit threshold (<3 non-HOLD) → NO referral hint', async () => {
    _setScanScorerForTest(specScorer({ COIN0: { call: 'BUY', confidence: 90 }, COIN1: { call: 'SELL', confidence: 60 } })); // 2 non-HOLD
    const r = await requestContext.run(
      { license: starter('scan-ref-b2'), sessionId: 'sess-scan-b2', ipHash: null },
      () => runScanTradeCall({ topN: 100, timeframe: '15m', exchange: 'BINANCE', limit: 10 }, starter('scan-ref-b2')),
    );
    if (isExhausted(r)) throw new Error('unexpected exhaustion');
    expect(r.eligible_non_hold).toBe(2);
    expect(r._algovault.referral_hint).toBeUndefined();
    expect(r._algovault.upgrade_hint).toBeUndefined();
  });

  it('≤1 aha referral per session — a second qualifying scan that session does NOT re-fire', async () => {
    _setScanScorerForTest(specScorer(SPEC));
    const run = () => requestContext.run(
      { license: starter('scan-ref-cap'), sessionId: 'sess-scan-cap', ipHash: null },
      () => runScanTradeCall({ topN: 100, timeframe: '15m', exchange: 'BINANCE', limit: 10 }, starter('scan-ref-cap')),
    );
    const r1 = await run();
    const r2 = await run();
    if (isExhausted(r1) || isExhausted(r2)) throw new Error('unexpected exhaustion');
    expect(r1._algovault.referral_hint?.from).toBe('aha_scan'); // first wins
    expect(r2._algovault.referral_hint).toBeUndefined();        // session cap holds
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
