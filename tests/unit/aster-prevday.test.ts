/**
 * OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch3 — SEC-11: Aster's 24h-prior price.
 *
 * THE DEFECT. The adapter read `prevDayPx` from `ticker.prevClosePrice`, a Binance
 * SPOT-only field that Aster's perp 24hr ticker does not return. `safeUpstreamNum(
 * undefined) ?? 0` yielded 0 — not null — so nothing logged, no fallback fired, and the
 * venue looked healthy in every readiness report. Meanwhile get-trade-call computes
 * `priceChange = prevDayPx > 0 ? (current - prevDayPx)/prevDayPx : 0`, so the
 * 15%-weight OI/momentum term scored a CONSTANT 0 on a PROMOTED venue: Aster verdicts
 * systematically differed from every other venue's for the same asset and could never
 * reach BUY/SELL on momentum.
 *
 * THE FIXTURE IS A CAPTURED LIVE PAYLOAD (2026-07-30), not a hand-written mock. The
 * pre-existing suite mocked `prevClosePrice: '80557.8'` — a field that does not exist —
 * and asserted on it, so that test passed BECAUSE of the bug. Fixtures for a venue
 * contract must come from the venue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsterAdapter } from '../../src/lib/adapters/aster.js';

// ── Captured live payload — `curl fapi.asterdex.com/fapi/v1/ticker/24hr?symbol=BTCUSDT`
// 2026-07-30. Note: NO prevClosePrice key. openPrice IS present.
const LIVE_TICKER_24HR = {
  symbol: 'BTCUSDT',
  priceChange: '-320.3',
  priceChangePercent: '-0.498',
  weightedAvgPrice: '64066.4',
  lastPrice: '64031.2',
  lastQty: '0.041',
  openPrice: '64351.5',
  highPrice: '64700.3',
  lowPrice: '63255.0',
  volume: '16183.988',
  quoteVolume: '1036850474.22',
  openTime: 1785306720000,
  closeTime: 1785393141100,
  firstId: 143220781,
  lastId: 143307398,
  count: 86615,
};

let mockResponses: Map<string, unknown>;
let originalFetch: typeof fetch;

function setMock(urlSubstring: string, body: unknown): void {
  mockResponses.set(urlSubstring, body);
}

beforeEach(() => {
  mockResponses = new Map();
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [frag, body] of mockResponses) {
      if (url.includes(frag)) {
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('not mocked: ' + url, { status: 404 });
  }) as unknown as typeof fetch;

  setMock('/fapi/v1/premiumIndex', { symbol: 'BTCUSDT', markPrice: '64031.2', lastFundingRate: '0.0001' });
  setMock('/fapi/v1/openInterest', { symbol: 'BTCUSDT', openInterest: '5599.890' });
  setMock('/fapi/v1/ticker/24hr', LIVE_TICKER_24HR);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Aster 24hr ticker contract', () => {
  it('the live payload does NOT carry prevClosePrice (the field the adapter used to read)', () => {
    expect(LIVE_TICKER_24HR).not.toHaveProperty('prevClosePrice');
    expect(LIVE_TICKER_24HR).toHaveProperty('openPrice');
  });

  it('priceChangePercent is a percent-NUMBER, not a fraction (per-venue divergence)', () => {
    const last = Number(LIVE_TICKER_24HR.lastPrice);
    const open = Number(LIVE_TICKER_24HR.openPrice);
    const pct = ((last - open) / open) * 100;
    expect(pct).toBeCloseTo(Number(LIVE_TICKER_24HR.priceChangePercent), 2);
  });
});

describe('AsterAdapter.getAssetContext — prevDayPx', () => {
  it('THE REGRESSION: prevDayPx is the real 24h open, never 0', async () => {
    const ctx = await new AsterAdapter().getAssetContext('BTC');
    expect(ctx.prevDayPx).toBeCloseTo(64351.5);
    expect(ctx.prevDayPx).toBeGreaterThan(0); // the invariant the audit asked for
  });

  it('the resulting 24h change matches an INDEPENDENTLY computed value', async () => {
    const ctx = await new AsterAdapter().getAssetContext('BTC');
    // Exactly the expression get-trade-call.ts uses for the momentum term.
    const priceChange = ctx.prevDayPx > 0 ? (ctx.markPx - ctx.prevDayPx) / ctx.prevDayPx : 0;
    const independent = Number(LIVE_TICKER_24HR.priceChangePercent) / 100;
    expect(priceChange).toBeCloseTo(independent, 4);
    expect(priceChange).not.toBe(0); // the old code pinned this to exactly 0
  });

  it('falls back to change-reconstruction when openPrice is absent — not to 0', async () => {
    const { openPrice: _dropped, ...noOpen } = LIVE_TICKER_24HR;
    setMock('/fapi/v1/ticker/24hr', noOpen);
    const ctx = await new AsterAdapter().getAssetContext('BTC');
    // open = last / (1 + change) = 64031.2 / (1 - 0.00498)
    expect(ctx.prevDayPx).toBeCloseTo(64031.2 / (1 - 0.00498), 0);
    expect(ctx.prevDayPx).toBeGreaterThan(0);
  });

  it('falls back to the hi/lo midpoint when both openPrice and the change are absent', async () => {
    const { openPrice: _o, priceChangePercent: _p, ...bare } = LIVE_TICKER_24HR;
    setMock('/fapi/v1/ticker/24hr', bare);
    const ctx = await new AsterAdapter().getAssetContext('BTC');
    expect(ctx.prevDayPx).toBeCloseTo((64700.3 + 63255.0) / 2, 1);
  });

  it('degrades to the last price (neutral momentum), never to a wrong-but-finite 0', async () => {
    setMock('/fapi/v1/ticker/24hr', { symbol: 'BTCUSDT', volume: '', quoteVolume: '', lastPrice: '64031.2' });
    const ctx = await new AsterAdapter().getAssetContext('BTC');
    expect(ctx.prevDayPx).toBeCloseTo(64031.2);
    const priceChange = ctx.prevDayPx > 0 ? (ctx.markPx - ctx.prevDayPx) / ctx.prevDayPx : 0;
    expect(priceChange).toBeCloseTo(0); // neutral, and REACHED deliberately
  });
});
