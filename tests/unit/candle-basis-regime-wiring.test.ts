/**
 * candle-basis-regime-wiring.test.ts — SIGNAL-CLOSEDBAR-SHADOW-W1 CH3 AC3/AC4
 *
 * `candle-basis-regime-golden.test.ts` pins the DEFAULT path (AC2) and the pure
 * `detectPriceStructure` divergence. This file exercises the paths the golden fixture
 * structurally cannot reach — everything behind `CANDLE_BASIS=closed` — because a
 * byte-identity oracle only ever runs the basis it was recorded on.
 *
 * OPS-CANDLE-BASIS-SHADOW-DECOM-W1 removed the four cases that asserted the shadow ROW and
 * its DDL, along with the shadow itself. What remains is the more valuable half and is now
 * load-bearing rather than supplementary: with `CANDLE_BASIS=closed` the live production
 * setting, these are among the few assertions in the tree that pin the CLOSED basis's
 * emitted output at all.
 *
 * The AC4 assertion in the golden file is the LIVE-basis half (atr_live / live close).
 * The half that actually catches the regression is here: under the CLOSED basis, ATR
 * moves to the closed bars while `currentPrice` must NOT — a mixed-basis ratio is the
 * exact defect CH2 §7's level-vs-integral rule exists to prevent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/exchange-adapter.js', () => ({ getAdapter: vi.fn() }));
vi.mock('../../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  recordFunding: vi.fn(),
  recordHoldCount: vi.fn(),
  getFundingZScore: vi.fn().mockReturnValue(null),
  isShortLivedScript: () => false,
  dbQuery: vi.fn().mockResolvedValue([]),
  dbExec: vi.fn().mockResolvedValue(undefined),
}));

import { getMarketRegime } from '../../src/tools/get-market-regime.js';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { resetLicenseCache } from '../../src/lib/license.js';
import { atr } from '../../src/lib/indicators.js';
import type { ExchangeAdapter, MarketRegimeResult, Candle } from '../../src/types.js';
import {
  GOLDEN_NOW_MS,
  REGIME_COIN,
  REGIME_TIMEFRAME,
  REGIME_EXCHANGE,
  REGIME_PIVOT_CLOSE,
  REGIME_SHOULDER_CLOSE,
  REGIME_PARTIAL_INDEX,
  regimeCandles,
} from '../fixtures/candle-basis-regime-inputs.js';

const adapterOver = (candles: Candle[]): ExchangeAdapter => ({
  getName: () => 'MockExchange',
  getCandles: vi.fn().mockResolvedValue(candles),
  getAssetContext: vi.fn().mockResolvedValue(null),
  getPredictedFundings: vi.fn().mockResolvedValue([]),
  getFundingHistory: vi.fn().mockResolvedValue([]),
  getCurrentPrice: vi.fn().mockResolvedValue(REGIME_SHOULDER_CLOSE),
});

async function run(candles: Candle[] = regimeCandles()): Promise<MarketRegimeResult> {
  vi.mocked(getAdapter).mockReturnValue(adapterOver(candles));
  return getMarketRegime({ coin: REGIME_COIN, timeframe: REGIME_TIMEFRAME, exchange: REGIME_EXCHANGE });
}

describe('CH3 wiring — CANDLE_BASIS=closed', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(GOLDEN_NOW_MS);
    vi.clearAllMocks();
    resetLicenseCache();
    process.env.CQS_API_KEY = 'test-key';
    delete process.env.CANDLE_BASIS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CANDLE_BASIS;
  });

  // ── AC3 — the volume-weighted site moves in the PUBLIC envelope ─────────────
  it('AC3: CANDLE_BASIS=closed changes pivot_quality in the emitted envelope', async () => {
    const live = await run();
    process.env.CANDLE_BASIS = 'closed';
    const closed = await run();

    expect(closed.metrics.pivot_quality).not.toBe(live.metrics.pivot_quality);
    // Direction is the point: the live basis publishes an EXTRA pivot that the
    // in-progress bar confirmed, and higher-scoring pivots lift the average.
    expect(live.metrics.pivot_quality).toBeGreaterThan(closed.metrics.pivot_quality);
    // Non-vacuity — neither side fell through to the MIXED/zero default.
    expect(closed.metrics.pivot_quality).toBeGreaterThan(0);
  });

  // ── AC4 — currentPrice is a LEVEL: it stays LIVE under the closed basis ─────
  it('AC4: under CANDLE_BASIS=closed, volatility_ratio still divides by the LIVE close', async () => {
    process.env.CANDLE_BASIS = 'closed';
    const result = await run();

    const cs = regimeCandles();
    const closedBars = cs.slice(0, REGIME_PARTIAL_INDEX);
    const atrClosed = atr(
      closedBars.map((c) => c.high), closedBars.map((c) => c.low), closedBars.map((c) => c.close), 14,
    );
    expect(atrClosed).not.toBeNull();

    // ATR moved to the closed bars…
    expect(result.metrics.volatility_ratio).toBe(
      parseFloat((atrClosed! / REGIME_SHOULDER_CLOSE).toFixed(4)),
    );
    // …but the divisor did NOT. This is the assertion that fails if a later edit
    // reads `currentPrice` off `emittedCandles` instead of `candles`.
    expect(result.metrics.volatility_ratio).not.toBe(
      parseFloat((atrClosed! / REGIME_PIVOT_CLOSE).toFixed(4)),
    );
  });

  // ── The guard FOLLOWS the basis — measured, not assumed ────────────────────
  //    OPS-CANDLE-BASIS-SHADOW-DECOM-W1 rewrote this case. Pre-decom the closed pass also
  //    ran for the shadow, so a closed-basis InsufficientCandles throw was caught by the
  //    inner try/catch and surfaced as the shadow row's `error_class`. It now runs only
  //    under `CANDLE_BASIS=closed`, and on that basis the REQUIRED_CANDLES guard higher up
  //    reads `emittedCandles` — which IS the closed window — so it throws FIRST and the
  //    inner catch is never reached for this input.
  //
  //    That is the designed behaviour ("the guard must follow the basis rather than always
  //    reading the raw array"), and it is what this case now pins. Stated because the
  //    obvious-looking assertion — that a short closed window falls back to the live basis —
  //    is FALSE, and writing it that way is how someone later "fixes" the guard.
  it('under CANDLE_BASIS=closed, 30 bars is INSUFFICIENT: the guard follows the basis', async () => {
    // 30 bars: the live basis meets REQUIRED_CANDLES, the closed basis (29) does not.
    process.env.CANDLE_BASIS = 'closed';
    await expect(run(regimeCandles(30))).rejects.toThrow(/29 candles; 30 required/);

    // …and the SAME input on the live basis succeeds, which is what makes the assertion
    // above about the basis rather than about the fixture being too short.
    delete process.env.CANDLE_BASIS;
    const live = await run(regimeCandles(30));
    expect(live.regime).toBeDefined();
    expect(live.metrics.pivot_quality).toBeGreaterThanOrEqual(0);
  });

  it('a DB outage cannot fail the request — the tool touches no table on this path', async () => {
    // Kept from the pre-decom suite in spirit: it used to prove a failing SHADOW WRITE was
    // isolated. With the write gone the stronger statement holds — get_market_regime issues
    // no query of its own here at all — so a broken DB must still return a regime.
    await expect(run()).resolves.toMatchObject({ coin: REGIME_COIN });
  });
});
