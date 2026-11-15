/**
 * params.ts — SR-ZONES-W1 §1. The frozen knobs of the support/resistance zone formula (zones.ts).
 *
 * Fitted ONCE, on tests/fixtures/sr-zones/btcusdt-1d-20261114.json only (BINANCE BTCUSDT 1d closed candles to
 * 2026-11-13), against Mr.1's BTC 1d chart at price 67,585.6 (AC1.1, tests/unit/sr-zones-anchor.test.ts). No outcome
 * was read: the fit compares zone positions with his chart, never what price did after a zone.
 *
 * Grid searched: k ∈ {1,2,3} × (no ranges | m ∈ {3,4,5,6} × w ∈ {0.5,0.75,1,1.25}) × monotone g1 ≤ g2 ≤ g3 from
 * {0.5,1,1.5} = 510 sets. 8 pass all four anchor rows: k ∈ {2,3}, m = 4, w = 0.5, g1 = 0.5, g3 ≥ 1. The frozen set is
 * the one with the most passing g-neighbours (5 of the 8): k = 3 (Mr.1's own v0 default), m = 4 (the spec default),
 * w = 0.5, g = [0.5, 1, 1.5]. At w = 1.0 (the spec default) a July 2026 range at 61.2k–61.9k becomes support 2, which
 * his chart does not mark. Anchor result with these knobs (ATR14 2,452):
 *   support 1 62,484–63,235 (2026-08-13…08-14) · support 2 57,759–59,189 (2026-06-25…07-01) ·
 *   support 3 52,511–54,384 (2024-09-06…09-09) · resistance 1 75,836–76,449 (2026-11-08).
 *
 * Read with zones.ts for what each knob does. All ATR multiples use ATR14 (Wilder) at the last closed candle.
 */
export const SR_ZONES_PARAMS = Object.freeze({
  /** H: closed candles read per timeframe (Binance serves the full window; R0 probe, 15m: 1200 bars, no holes). */
  historyBars: 1000,
  /** Wilder ATR period. */
  atrPeriod: 14,
  /** k: a swing low/high is the extreme of the k candles on each side, so it is confirmed k closed candles later. */
  swingWindow: 3,
  /** m: a trading range is at least this many consecutive candles... */
  rangeMinBars: 4,
  /** w: ...whose closes stay within w × ATR (ATR at the range's last candle). */
  rangeCloseSpreadAtr: 0.5,
  /** g1..g3: a turning point joins zone r when it sits within g_r × ATR of zone r's seed price. */
  memberBandAtr: Object.freeze([0.5, 1, 1.5]) as readonly number[],
  /** Each next seed sits beyond the previous zone's far edge by at least this × ATR. */
  seedSpacingAtr: 0.5,
  /** A zone is at least this × ATR wide; a narrower one is widened away from price. */
  minWidthAtr: 0.25,
  /** At most this many zones per side. */
  maxZonesPerSide: 3,
  /** touch_bars_90 window, in closed candles. */
  touchWindowBars: 90,
  /** tests_30 window, in closed candles. */
  testWindowBars: 30,
  /** volume_vs_20 baseline, in closed candles before the last one. */
  volumeWindowBars: 20,
  /** A zone flips after this many consecutive closes beyond it. */
  breakCloses: 2,
  /** Fewest closed candles a timeframe needs: the 20-candle volume baseline plus the candle it is compared with. */
  minClosedBars: 21,
});
