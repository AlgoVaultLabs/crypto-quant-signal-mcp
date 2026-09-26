/**
 * venue-candle-horizons.ts — OPS-BDIR-V3-PANEL-READINESS-W1 CH2.
 *
 * How far back each venue's candle endpoint SERVES history, per timeframe, in days — measured, not
 * assumed. A directional label needs the candles from the signal's entry onward, so a row older than
 * its (venue, timeframe) depth can never be labelled from that venue's API: it is lost, not deferred.
 * The nightly labeler uses this to reach rows that are about to cross their horizon FIRST.
 *
 * It orders WHICH rows the labeler reaches. It never changes WHAT label a row gets — the barrier
 * arithmetic lives in directional-labeler.ts and is untouched.
 *
 * MEASURED 2026-09-26 (instrument recorded beside the numbers, per the monitoring law):
 *   * HL — the public `candleSnapshot` endpoint (5,000 most recent candles): 5m 17.48 d, 15m 52.2 d,
 *     30m 104 d, 1h 208 d. Only 5m is shorter than the nightly reach, so only 5m is listed.
 *   * every other venue — the SHIPPED adapter `getCandles` for BTC, in the app container on the prod
 *     IP, batch class (`ops/scripts/probe-candle-horizons.cjs`): the deepest window found AVAILABLE,
 *     bracketed then refined to 0.25 d. A lower bound, which errs toward calling a row critical early.
 *   ASTER, BINANCE, BYBIT, GATE, KUCOIN and OKX served >= 25 d on every timeframe probed; BITGET did
 *   except 2h. WEEX 30m+ was not probed (its lane is saturated — ~53 s per request), so it is absent
 *   and therefore treated as deep; that under-prioritises WEEX 30m at worst, it never mislabels.
 *
 * ONLY pairs whose depth is SHORTER than the nightly labeler's 21-day reach are listed. An absent pair
 * is treated as deep (Infinity), never as zero history — a missing entry must not make a venue's whole
 * backlog look already lost. A venue that changes its retention makes this table stale; the cost is
 * ordering, and the per-night past-horizon count the labeler logs is what surfaces it.
 */
export const CANDLE_HORIZON_DAYS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  HL: { '5m': 17.48 },
  BINGX: { '3m': 2, '5m': 3.25, '15m': 10.25, '30m': 20.75 },
  HTX: { '3m': 3.25, '5m': 3.25, '15m': 10.25, '30m': 20.75 },
  MEXC: { '3m': 6.75, '5m': 6.75, '15m': 20.75 },
  PHEMEX: { '3m': 3.25, '5m': 3.25, '15m': 10.25, '30m': 20.75 },
  WEEX: { '3m': 3.25, '5m': 3.25, '15m': 10.25 },
  XT: { '3m': 3.25, '5m': 3.25, '15m': 10.25, '30m': 20.75 },
  WHITEBIT: { '15m': 10.25, '30m': 20.75 },
  BITGET: { '2h': 8.75 },
};

export const CANDLE_HORIZONS_MEASURED_AT = '2026-09-26';

/** The served history depth in days for a (venue, timeframe); Infinity when not measured short. */
export function candleHorizonDays(venue: string, timeframe: string): number {
  return CANDLE_HORIZON_DAYS[venue]?.[timeframe] ?? Infinity;
}
