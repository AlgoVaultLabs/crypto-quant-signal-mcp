// sr-htf/config.ts — EDGE-SR-HTF-LEVELS-W1: every number this study's registration freezes, in one leaf.
//
// The question: do daily/weekly levels (`htf`) or daily volume points of control (`vpoc`) bounce more often than
// matched random zones, on 2021-01-01 → 2025-11-12 Binance candles nobody has read an S/R outcome on? Everything
// else — the zone rule Z1, the served set, N, M, k, the break rule, the control rule, the grid, the presence rule,
// the cluster floor and the bootstrap — is EDGE-SR-LEVEL-BACKTEST-W1's, imported from src/scripts/sr-backtest/ and
// never restated here. A change to this file after the registration has landed is a PROCEDURE §8 deviation.
import { DAY } from '../sr-backtest/spec.js';

export const WAVE = 'EDGE-SR-HTF-LEVELS-W1';
export const WEEK = 7 * DAY;

/** The window, the cells and the decision numbers. */
export const STUDY_HTF = Object.freeze({
  /** First instant of the grid (its origin) — a UTC midnight. */
  startMs: Date.UTC(2021, 0, 1),
  /** The closed study's `startMs`: every bar this study reads closes at or before it. */
  endMs: Date.UTC(2025, 10, 12),
  /** The hold-out: served instants on UTC days from here on. */
  holdoutStartMs: Date.UTC(2025, 0, 1),
  /** A coin is evaluated from its first full UTC day of Binance perp history plus this many days (the 1d warm-up,
   *  which also covers 300 bars of every shorter timeframe and at least 30 complete weeks). */
  warmupDays: 300,
  /** H_A and H_B are read in these cells; the 1d cell carries the descriptive z1 read only. */
  cells: Object.freeze(['1h', '4h']) as readonly string[],
  descriptiveCell: '1d',
  /** Point floor of both primaries, in pp, and the interval level (two primaries: 0.05 / 2 per test). */
  floorPp: 3.0,
  ciLevel: 0.975,
});

/** The two new sources' own numbers. `openWeek` and `pocCurrentDay` exist only so a test can break the rule; the
 *  registered values are false. */
export interface HtfParams {
  /** Complete weeks Z1 reads on the 1w layer: the last `weekMaxBars`, and the source is undefined below `weekMinBars`. */
  weekMinBars: number;
  weekMaxBars: number;
  /** Daily points of control: one per complete UTC day, the last `pocDays` of them. */
  pocDays: number;
  /** Bin width of a day's volume profile, in ATR14 of the 1d bars as of that day's close. */
  pocBinAtr: number;
  openWeek: boolean;
  pocCurrentDay: boolean;
}

export const HP: Readonly<HtfParams> = Object.freeze({
  weekMinBars: 30,
  weekMaxBars: 300,
  pocDays: 20,
  pocBinAtr: 0.25,
  openWeek: false,
  pocCurrentDay: false,
});

/** EDGE-SR-LEVEL-BACKTEST-W1's registered panel (its §3), in its volume order. Every coin enters from its own first
 *  full day of Binance perp history; the store holds one plan and one manifest per coin (`planLabel`). */
export const PANEL: readonly string[] = Object.freeze([
  'BTC', 'ETH', 'ZEC', 'SOL', 'XRP', 'PEPE', 'NEAR', 'DOGE', 'BNB', 'UNI', 'ENA', 'SUI', 'AVAX', 'ADA', 'LINK', 'AAVE', 'ONE', 'WLD', 'INJ', 'TAO',
  'XMR', 'ARB', 'QNT', 'LTC', 'XLM', 'FIL', 'ONDO', 'BCH', 'ZRO', 'ICP', 'ETHFI', 'DOT', 'FET', 'HBAR', 'DASH', 'PENGU', 'TRX', 'APT', 'SHIB', 'TIA',
  'AERO', 'PYTH', 'OP', 'STRK', 'CRV', 'FARTCOIN', 'JUP', 'CYBER', 'ETC', 'BONK',
]);

export const VENUE = 'BINANCE';
/** The plan and manifest label of one coin's window (fetch-store.ts --label). */
export const planLabel = (coin: string): string => `${VENUE}-${coin}`;

/** The null calibration (AC1.5): seeded driftless walks with seeded volume through the whole harness. */
export const CALIBRATION_HTF = Object.freeze({
  replications: 100,
  walks: 50,
  /** Daily bars before the first instant (the registered warm-up). */
  warmupDays: 300,
  evalDays: Object.freeze({ '1h': 40, '4h': 60 }) as Readonly<Record<string, number>>,
  /** A fixed synthetic epoch (a UTC midnight); the calendar carries no meaning. */
  startMs: Date.UTC(2021, 0, 1),
  seed: 20261113,
  /** Each 15-minute bar's volume is uniform on 1 … volumeMax, from its own seeded stream. */
  volumeMax: 1000,
});
