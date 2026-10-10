/**
 * venue-candle-reach.ts — OPS-ALARM-OWNER-DERIVATION-W1 CH1. The ONE table of "how far back does
 * this venue still serve candles for this timeframe", and the SQL predicate generated from it.
 *
 * ── WHY IT MOVED HERE ───────────────────────────────────────────────────────────────────────────
 * The table was born inside `backfill-directional-labels.ts` (EDGE-ADS1-SCORECARD-W1-V2 CH1 probe 4)
 * and only the labeler read it. The PFE outcome backfill fetches through the SAME adapters and read
 * nothing, so a row it could no longer serve was retried forever: on HL / Gate-shaped venues the fetch
 * returns nothing (or HL answers `500`) and the row accretes as sediment; on the six count-limited
 * venues (BINGX, HTX, PHEMEX, WEEX, WHITEBIT, XT — newest 1,000 bars, no start parameter) every
 * returned bar passes the `>= startTime` filter and `computePFEMAE` FILLS the row from bars days
 * after the signal. One cause, two symptoms. The queue, the census and the labeler now read this file.
 *
 * ── THE CONTRACT ────────────────────────────────────────────────────────────────────────────────
 *  * VALUES ARE MEASURED, NEVER EDITED HERE. Byte-identical to the 2026-09-27 measurement the labeler
 *    shipped (instrument: the SHIPPED adapter `getCandles` for BTC in the app container on the prod
 *    IP, batch class, lower bounds at ≤ 1 d resolution; HL = 5,000 candles; WEEX = 1,000 candles).
 *    The relabel and ADS-1 sit inside open registrations and read these numbers.
 *  * EXHAUSTIVE OVER ExchangeId. `{}` means "served every row probed" (unbounded); omitting a venue is
 *    a compile error, pinned by `tests/unit/venue-candle-reach.test.ts`.
 *  * A lower bound errs early: a row within the bracket of its depth leaves the queue a little before
 *    the venue truly stops serving it. Such a row has already failed for days.
 *  * `venue-candle-horizons.ts` is a second measurement of the same fact (2026-09-26, < 21 d pairs).
 *    It is deliberately NOT merged yet — its 7 in-scope disagreements are pinned shrink-only in the
 *    test above, and merging waits for LRW + ADS-1 to close.
 *  * KNOWN EXCEEDANCE (measured 2026-10-10, R0.2d of this wave): five entries claim a deeper reach than
 *    the adapter's served depth (1,000 × served step) — HTX / PHEMEX / WHITEBIT / XT `2h` = 42 d vs
 *    41.67 d (2h is served as 1h bars) and WEEX `2h` = 83.33 d vs 41.67 d. Correcting them is a value
 *    change this wave may not make; they are pinned shrink-only by `tests/unit/venue-reach-served-
 *    depth.test.ts`, and they held ZERO pending rows in their exceedance band at measurement.
 */
import type { ExchangeId } from '../types.js';

/** When the table below was measured (the instrument is described in the header). */
export const EXPIRY_REACH_DAYS_MEASURED_AT = '2026-09-27';

/**
 * Measured candle depth (days) per venue and timeframe, for the pairs SHALLOWER than their rows'
 * age at measurement. An absent pair served every row probed.
 */
export const VENUE_CANDLE_REACH_DAYS: Readonly<Record<ExchangeId, Readonly<Partial<Record<string, number>>>>> = {
  HL: { '3m': 10.41, '5m': 17.36, '15m': 52.08, '30m': 104.16, '1h': 208.33 },
  BINANCE: {},
  BYBIT: {},
  OKX: {},
  BITGET: { '2h': 8.75, '8h': 51 },
  ASTER: {},
  EDGEX: {},
  GATE: { '3m': 34.5, '5m': 34.5, '15m': 104 },
  MEXC: { '3m': 6.75, '5m': 6.75, '15m': 20.75, '30m': 41, '1h': 83, '2h': 83 },
  KUCOIN: {},
  PHEMEX: { '3m': 3.25, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
  BINGX: { '3m': 2, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 83 },
  HTX: { '3m': 3.25, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
  WEEX: { '3m': 2.08, '5m': 3.47, '15m': 10.41, '30m': 20.83, '1h': 41.66, '2h': 83.33, '4h': 166.66 },
  BITMART: {},
  XT: { '3m': 3.25, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
  WHITEBIT: { '5m': 10.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
};

/**
 * The finite-reach view under its original name and shape (venue → timeframe → days), venues in
 * alphabetical order as the labeler declared them. A PROJECTION of the table above, never a copy.
 */
export const EXPIRY_REACH_DAYS: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(VENUE_CANDLE_REACH_DAYS) as ExchangeId[])
      .filter((v) => Object.keys(VENUE_CANDLE_REACH_DAYS[v]).length > 0)
      .sort()
      .map((v) => [v, VENUE_CANDLE_REACH_DAYS[v] as Readonly<Record<string, number>>]),
  ),
);

/** Served depth in days; `Infinity` for a pair the table does not list (unchanged semantics). */
export function expiryReachDays(venue: string, timeframe: string): number {
  return EXPIRY_REACH_DAYS[venue]?.[timeframe] ?? Infinity;
}

/** HL's candle depth: `candleSnapshot` serves the newest 5,000 candles of an interval (the HL rows of
 *  the table are this count × the step; a test pins the two together). */
export const HL_CANDLE_DEPTH = 5_000;

/** One margin hour inside the measured depth, so a row on the edge is skipped rather than fetched empty. */
export const REACH_MARGIN_S = 3600;

/**
 * Pairs the aligned would-fill guard (R0.3) proved still SERVABLE past their table depth. A pair here
 * keeps every row in the queue — its table VALUE is never edited to get there. Measured 2026-10-10:
 * 0 aligned would-fills across all 14 pairs holding past-reach rows (49 samples, 26 / 26 in-depth
 * controls filled in the same run), so the set is empty. Keys are `<VENUE>:<timeframe>`.
 */
export const PAST_REACH_EXCLUDED_PAIRS: ReadonlySet<string> = new Set<string>();

/** The venue key the fill path uses: an empty `exchange` is HL (`sig.exchange || 'HL'`). */
export const SQL_VENUE_EXPR = "COALESCE(NULLIF(exchange,''),'HL')";

/** The first `created_at` (epoch s) still inside reach; a row strictly older is past reach. The
 *  labeler's own arithmetic (`backfill-directional-labels.ts`, `reachCutS`). */
export function reachCutoffS(reachDays: number, nowS: number): number {
  return Math.floor(nowS - reachDays * 86_400 + REACH_MARGIN_S);
}

/**
 * The past-reach predicate as SQL over `signals`: an explicit OR-chain of one arm per FINITE pair,
 * `(<venue> = 'V' AND timeframe = 'tf' AND created_at < <cutoff>)`. PURE. Generated from the table
 * like `buildMaturityClause`, so the clause is inspectable in a log and assertable in a test.
 *
 * It references NO attempt or cooldown column — it is a clock against the venue's served depth, and
 * nothing the producer does can move it. That is what makes excluding these rows an exit and not a
 * tombstone: re-measure the table deeper and the rows re-enter on the next build.
 *
 * An empty chain is `(FALSE)` — "excludes nothing", the safe direction for an exclusion clause.
 */
export function buildPastReachClause(
  nowS: number,
  excluded: ReadonlySet<string> = PAST_REACH_EXCLUDED_PAIRS,
): string {
  const now = Math.trunc(nowS);
  const arms: string[] = [];
  for (const venue of (Object.keys(VENUE_CANDLE_REACH_DAYS) as ExchangeId[]).sort()) {
    const pairs = VENUE_CANDLE_REACH_DAYS[venue];
    for (const [tf, days] of Object.entries(pairs)) {
      if (typeof days !== 'number' || !Number.isFinite(days)) continue;
      if (excluded.has(`${venue}:${tf}`)) continue;
      // The values are ours, but a builder that interpolates into SQL refuses anything that is not a
      // bare token rather than trusting every future edit of the table to be careful.
      if (!/^[A-Z0-9]+$/.test(venue) || !/^[0-9]+[mhd]$/.test(tf)) {
        throw new Error(`buildPastReachClause: unsafe table key ${JSON.stringify(`${venue}:${tf}`)}`);
      }
      arms.push(`(${SQL_VENUE_EXPR} = '${venue}' AND timeframe = '${tf}' AND created_at < ${reachCutoffS(days, now)})`);
    }
  }
  return arms.length === 0 ? '(FALSE)' : `(${arms.join(' OR ')})`;
}
