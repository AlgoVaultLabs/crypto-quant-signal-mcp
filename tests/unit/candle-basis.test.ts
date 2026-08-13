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
import { getTradeSignal, computeIndicatorScores } from '../../src/tools/get-trade-call.js';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { getCandleBasis } from '../../src/lib/candle-basis-flag.js';
import { splitCandleWindow } from '../../src/lib/candle-window.js';
import { resetLicenseCache, _resetCallTrackersForTest } from '../../src/lib/license.js';
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


describe('CH2 — closed-bar basis', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    resetLicenseCache();
    // PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (R-A): every call now charges the shared free
    // meter, so without a per-test reset each test inherits the previous test's `used` and the
    // envelope comparisons below compare "3rd call" with "1st call". `resetLicenseCache` clears
    // the cached LICENSE, which is a different module-level cache and never touched the meters.
    _resetCallTrackersForTest();
    process.env.CQS_API_KEY = 'test-key';
    delete process.env.CANDLE_BASIS;
    _clearCache();
    _setScorerOverride(null);
    _setSnapshotForTest([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    _clearCache();
    _setScorerOverride(null);
    delete process.env.CANDLE_BASIS;
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
    // OPS-CANDLE-BASIS-SHADOW-DECOM-W1 dropped the shadow-ROW assertions these cases carried.
    // What survives is the window arithmetic and the LIVE emission, which is what the boundary
    // was really about; the closed basis's own behaviour at the boundary is pinned by
    // candle-basis-regime-wiring.test.ts "the guard follows the basis".
    it('30 candles: the live basis emits, and the closed window is one short', async () => {
      const candles = makeCandles(30);
      const w = splitCandleWindow(candles, BAR_MS, NOW);
      expect(candles.length).toBe(30); // live: meets the bar
      expect(w.closed.length).toBe(29); // closed: one short — §5's exact scenario

      vi.mocked(getAdapter).mockReturnValue(makeAdapter(candles));
      const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' });
      expect(result.call).toBeDefined();
    });

    it('31 candles: both bases have enough bars to derive', async () => {
      const candles = makeCandles(31);
      expect(splitCandleWindow(candles, BAR_MS, NOW).closed.length).toBe(30);

      vi.mocked(getAdapter).mockReturnValue(makeAdapter(candles));
      const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' });
      expect(result.call).toBeDefined();

      process.env.CANDLE_BASIS = 'closed';
      _resetCallTrackersForTest();
      vi.mocked(getAdapter).mockReturnValue(makeAdapter(candles));
      const closed = await getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' });
      expect(closed.call).toBeDefined();
    });
  });

  // ── The venue-omits-the-partial-bar case ─────────────────────────────────
  describe('venue omits the in-progress bar', () => {
    // The shadow-row half of this case (a NULL elapsed_fraction column) went with the shadow.
    // The splitCandleWindow property it also asserted is the durable one and is kept: a venue
    // that returns only closed bars must not have its newest genuinely-closed bar dropped.
    it('never drops a genuinely-closed newest bar, and both bases then agree', async () => {
      // Every bar closed: shift the series back one full interval.
      const candles = makeCandles(100).map((c) => ({ ...c, time: c.time - BAR_MS }));
      const w = splitCandleWindow(candles, BAR_MS, NOW);
      expect(w.partial).toBeNull();
      expect(w.closed.length).toBe(100);

      // Both bases see the SAME window, so the emitted verdict must be identical.
      vi.mocked(getAdapter).mockReturnValue(makeAdapter(candles));
      const live = await getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' });

      process.env.CANDLE_BASIS = 'closed';
      _resetCallTrackersForTest();
      vi.mocked(getAdapter).mockReturnValue(makeAdapter(candles));
      const closed = await getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' });

      expect(closed.call).toBe(live.call);
      expect(closed.confidence).toBe(live.confidence);
    });
  });
});
