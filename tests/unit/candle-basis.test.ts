/**
 * candle-basis.test.ts — SIGNAL-CLOSEDBAR-SHADOW-W1 CH2, AC2–AC7 + AC9.
 *
 * AC1 (byte-identity vs the golden envelope) lives in candle-basis-golden.test.ts.
 *
 * The pure ACs (2, 3, 9-shape) are asserted against `computeIndicatorScores` +
 * `splitCandleWindow` directly rather than through `getTradeSignal`: the property being
 * proven is about the SCORING WINDOW, and driving it through the full tool would make
 * the assertion depend on quota, licensing, the grid and six mocks — a weaker test of a
 * stronger claim. The wiring ACs (4–7) do go through `getTradeSignal`, because wiring is
 * exactly what they are about.
 *
 * NOTE on AC2's numbers: the diagnostic's `0.345 → −70` / `0.927 → −30` figures describe
 * SHAPE A (the rejected normalisation) and are deliberately NOT asserted here.
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
// The shadow store is mocked so the ROW is observable: AC5/6/7 are claims about which
// rows get written, and asserting on a swallowing fire-and-forget writer any other way
// would be asserting on absence.
vi.mock('../../src/lib/candle-basis-shadow.js', () => ({
  recordCandleBasisShadow: vi.fn().mockResolvedValue(true),
  _resetCandleBasisShadowEnsure: vi.fn(),
}));

import { getTradeSignal, computeIndicatorScores } from '../../src/tools/get-trade-call.js';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { recordCandleBasisShadow } from '../../src/lib/candle-basis-shadow.js';
import { getCandleBasis, isCandleBasisShadowEnabled } from '../../src/lib/candle-basis-flag.js';
import { splitCandleWindow } from '../../src/lib/candle-window.js';
import { resetLicenseCache } from '../../src/lib/license.js';
import { _setSnapshotForTest, _clearCache, _setScorerOverride } from '../../src/lib/cross-asset-grid.js';
import type { ExchangeAdapter, Candle } from '../../src/types.js';
import { goldenAssetContext } from '../fixtures/candle-basis-golden-inputs.js';

const BAR_MS = 3_600_000;
/** Open of the newest (in-progress) bar. */
const BAR_OPEN = Date.UTC(2026, 6, 29, 12, 0, 0);
/** 6 minutes into that bar ⇒ it is still open. */
const NOW = BAR_OPEN + 6 * 60_000;

/**
 * `count` ascending bars where the LAST one is still in progress. Integer closes, for the
 * same cross-platform-determinism reason as the golden inputs.
 */
function makeCandles(
  count: number,
  opts: { partialVolume?: number; lastClosedVolume?: number; baseVolume?: number } = {},
): Candle[] {
  const { partialVolume = 160, lastClosedVolume = 1600, baseVolume = 1000 } = opts;
  return Array.from({ length: count }, (_, i) => {
    const close = 3000 + ((i * 37) % 41) - 20;
    const volume = i === count - 1 ? partialVolume : i === count - 2 ? lastClosedVolume : baseVolume;
    return {
      open: close - 2,
      high: close + 10,
      low: close - 10,
      close,
      volume,
      time: BAR_OPEN - (count - 1 - i) * BAR_MS,
    };
  });
}

const scoreArgs = { fundingRateAnnualized: 0.0876, priceChange: -0.002, openInterest: 5_000_000 };

const makeAdapter = (candles: Candle[]): ExchangeAdapter => ({
  getName: () => 'MockExchange',
  getCandles: vi.fn().mockResolvedValue(candles),
  getAssetContext: vi.fn().mockResolvedValue(goldenAssetContext()),
  getPredictedFundings: vi.fn().mockResolvedValue([]),
  getFundingHistory: vi.fn().mockResolvedValue([]),
  getCurrentPrice: vi.fn().mockResolvedValue(2994),
});

const rowOf = (i = 0) => vi.mocked(recordCandleBasisShadow).mock.calls[i][0];

describe('CH2 — closed-bar basis', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    resetLicenseCache();
    process.env.CQS_API_KEY = 'test-key';
    delete process.env.CANDLE_BASIS;
    delete process.env.CANDLE_BASIS_SHADOW_ENABLED;
    _clearCache();
    _setScorerOverride(null);
    _setSnapshotForTest([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    _clearCache();
    _setScorerOverride(null);
    delete process.env.CANDLE_BASIS;
    delete process.env.CANDLE_BASIS_SHADOW_ENABLED;
  });

  // ── AC4 — the flag itself ────────────────────────────────────────────────
  describe('AC4 — CANDLE_BASIS default-deny', () => {
    it.each([
      ['unset', undefined],
      ['garbage', 'garbage'],
      ['CLOSED (wrong case)', 'CLOSED'],
      ['true', 'true'],
      ['1', '1'],
      ['empty', ''],
    ])('%s ⇒ live', (_label, value) => {
      if (value === undefined) delete process.env.CANDLE_BASIS;
      else process.env.CANDLE_BASIS = value;
      expect(getCandleBasis()).toBe('live');
    });

    it("only the exact string 'closed' selects the closed basis", () => {
      process.env.CANDLE_BASIS = 'closed';
      expect(getCandleBasis()).toBe('closed');
    });

    it('CANDLE_BASIS_SHADOW_ENABLED defaults ON and is turned off only by 0/false', () => {
      delete process.env.CANDLE_BASIS_SHADOW_ENABLED;
      expect(isCandleBasisShadowEnabled()).toBe(true);
      process.env.CANDLE_BASIS_SHADOW_ENABLED = '0';
      expect(isCandleBasisShadowEnabled()).toBe(false);
      process.env.CANDLE_BASIS_SHADOW_ENABLED = 'false';
      expect(isCandleBasisShadowEnabled()).toBe(false);
      process.env.CANDLE_BASIS_SHADOW_ENABLED = 'yes';
      expect(isCandleBasisShadowEnabled()).toBe(true);
    });
  });

  // ── AC2 — the property the whole wave exists to create ───────────────────
  describe('AC2 — closed-basis volume score is invariant to call time within a bar', () => {
    it('scores identically at bar-open+10s and bar-open+50min', () => {
      const candles = makeCandles(100);
      const early = splitCandleWindow(candles, BAR_MS, BAR_OPEN + 10_000);
      const late = splitCandleWindow(candles, BAR_MS, BAR_OPEN + 50 * 60_000);

      // Same closed set at both instants — the partial bar is open throughout.
      expect(early.closed.length).toBe(late.closed.length);
      expect(early.partial).not.toBeNull();
      expect(late.partial).not.toBeNull();

      const a = computeIndicatorScores({ candles: early.closed, ...scoreArgs });
      const b = computeIndicatorScores({ candles: late.closed, ...scoreArgs });
      expect(a.volumeScore).toBe(b.volumeScore);
      expect(a).toEqual(b); // the whole score set, not just volume

      // ...whereas the LIVE basis is NOT time-invariant, which is the defect. Same
      // candles, but a partial bar that has accumulated more volume by late-bar.
      const liveEarly = computeIndicatorScores({ candles, ...scoreArgs });
      const grown = makeCandles(100, { partialVolume: 1500 });
      const liveLate = computeIndicatorScores({ candles: grown, ...scoreArgs });
      expect(liveEarly.volumeScore).not.toBe(liveLate.volumeScore);
    });
  });

  // ── AC3 — proves the fix is not a no-op ──────────────────────────────────
  describe('AC3 — live and closed volume scores differ on a materially incomplete bar', () => {
    it('live scores the −70 floor while closed scores +50', () => {
      const candles = makeCandles(100);
      const w = splitCandleWindow(candles, BAR_MS, NOW);

      const live = computeIndicatorScores({ candles, ...scoreArgs });
      const closed = computeIndicatorScores({ candles: w.closed, ...scoreArgs });

      expect(live.volumeScore).toBe(-70);
      expect(closed.volumeScore).toBe(50);
      expect(live.volumeScore).not.toBe(closed.volumeScore);
      // The partial bar is the ONLY difference between the two windows.
      expect(w.closed.length).toBe(candles.length - 1);
      expect(w.partial).toEqual(candles[candles.length - 1]);
    });
  });

  // ── AC9 — REQUIRED_CANDLES boundary under both bases ─────────────────────
  describe('AC9 — REQUIRED_CANDLES boundary at 30 and 31', () => {
    it('30 candles: live basis emits, closed basis has only 29 and cannot', async () => {
      const candles = makeCandles(30);
      const w = splitCandleWindow(candles, BAR_MS, NOW);
      expect(candles.length).toBe(30); // live: meets the bar
      expect(w.closed.length).toBe(29); // closed: one short — §5's exact scenario

      vi.mocked(getAdapter).mockReturnValue(makeAdapter(candles));
      const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' });

      // The live path is UNAFFECTED by the shadow branch throwing.
      expect(result.call).toBeDefined();
      expect(recordCandleBasisShadow).toHaveBeenCalledTimes(1);
      const row = rowOf();
      expect(row.callClosed).toBeNull();
      expect(row.errorClass).toBe('InsufficientCandlesError');
      expect(row.nTotal).toBe(30);
      expect(row.nClosed).toBe(29);
    });

    it('31 candles: both bases derive', async () => {
      const candles = makeCandles(31);
      expect(splitCandleWindow(candles, BAR_MS, NOW).closed.length).toBe(30);

      vi.mocked(getAdapter).mockReturnValue(makeAdapter(candles));
      const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' });

      expect(result.call).toBeDefined();
      const row = rowOf();
      expect(row.callClosed).not.toBeNull();
      expect(row.errorClass).toBeNull();
      expect(row.nClosed).toBe(30);
      expect(row.nTotal).toBe(31);
    });
  });

  // ── AC6 — a throwing shadow branch never reaches the live path ───────────
  describe('AC6 — closed-basis derivation throwing leaves the live response unaltered', () => {
    it('emits the same envelope as with the shadow disabled, and records the error', async () => {
      const candles = makeCandles(30); // forces the closed branch to throw

      process.env.CANDLE_BASIS_SHADOW_ENABLED = '0';
      vi.mocked(getAdapter).mockReturnValue(makeAdapter(candles));
      const withoutShadow = await getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' });
      expect(recordCandleBasisShadow).not.toHaveBeenCalled();

      vi.clearAllMocks();
      delete process.env.CANDLE_BASIS_SHADOW_ENABLED; // shadow ON ⇒ the branch runs and throws
      vi.mocked(getAdapter).mockReturnValue(makeAdapter(candles));
      const withShadow = await getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' });

      expect(withShadow).toEqual(withoutShadow);
      expect(rowOf().errorClass).toBe('InsufficientCandlesError');
      expect(rowOf().callClosed).toBeNull();
    });
  });

  // ── AC5 — the off-switch really switches work off ────────────────────────
  describe('AC5 — CANDLE_BASIS_SHADOW_ENABLED=0 does no second derivation and writes no row', () => {
    it('writes no shadow row and leaves the response unchanged', async () => {
      const candles = makeCandles(100);

      vi.mocked(getAdapter).mockReturnValue(makeAdapter(candles));
      const on = await getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' });
      expect(recordCandleBasisShadow).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();
      process.env.CANDLE_BASIS_SHADOW_ENABLED = '0';
      vi.mocked(getAdapter).mockReturnValue(makeAdapter(candles));
      const off = await getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' });

      expect(recordCandleBasisShadow).not.toHaveBeenCalled();
      expect(off).toEqual(on); // the emitted verdict never depended on the shadow
    });
  });

  // ── AC7 — internal callers are excluded ──────────────────────────────────
  describe('AC7 — a row is written for real callers and never for internal ones', () => {
    it('writes for a non-internal call', async () => {
      vi.mocked(getAdapter).mockReturnValue(makeAdapter(makeCandles(100)));
      await getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' });
      expect(recordCandleBasisShadow).toHaveBeenCalledTimes(1);

      const row = rowOf();
      expect(row.coin).toBe('BTC');
      expect(row.timeframe).toBe('1h');
      expect(row.callLive).toBeDefined();
      // Non-vacuity: the component scores really are captured, live vs closed, and they
      // diverge — a row of nulls would satisfy a shape-only assertion.
      expect(row.volScoreLive).toBe(-70);
      expect(row.volScoreClosed).toBe(50);
      expect(row.nTotal).toBe(100);
      expect(row.nClosed).toBe(99);
      expect(row.elapsedFraction).toBeCloseTo(0.1, 5);
    });

    it('writes nothing for an internal (grid-refresh) call', async () => {
      vi.mocked(getAdapter).mockReturnValue(makeAdapter(makeCandles(100)));
      await getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE', internal: true });
      expect(recordCandleBasisShadow).not.toHaveBeenCalled();
    });
  });

  // ── The venue-omits-the-partial-bar case ─────────────────────────────────
  describe('venue omits the in-progress bar', () => {
    it('records a NULL elapsed_fraction and never drops a genuinely-closed newest bar', async () => {
      // Every bar closed: shift the series back one full interval.
      const candles = makeCandles(100).map((c) => ({ ...c, time: c.time - BAR_MS }));
      const w = splitCandleWindow(candles, BAR_MS, NOW);
      expect(w.partial).toBeNull();
      expect(w.closed.length).toBe(100);

      vi.mocked(getAdapter).mockReturnValue(makeAdapter(candles));
      await getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' });

      const row = rowOf();
      expect(row.elapsedFraction).toBeNull();
      expect(row.nClosed).toBe(100);
      expect(row.nTotal).toBe(100);
      // Both bases see the same window, so the scores cannot diverge.
      expect(row.volScoreLive).toBe(row.volScoreClosed);
    });
  });
});
