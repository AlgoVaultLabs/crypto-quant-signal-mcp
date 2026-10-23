/**
 * live-price.ts — OPS-SERVED-CANDLE-TRUTH-W1 CH3a (Cowork Q8; Mr.1 Q10 = C). The ONE derivation of a call's LIVE price:
 * `currentPrice` in src/tools/get-trade-call.ts, which is the reported price, the track-record entry price and the
 * value `recordSignal` stores. Scans and the seeder reach it through `getTradeSignal`; `recordSignal` has no other caller.
 *
 * Why it exists: under CANDLE_BASIS=closed the verdict reads closed bars only (splitCandleWindow), so a candle window
 * that lacks the venue's forming bar costs exactly one thing, the entry price. A venue whose kline endpoints serve
 * closed bars only (PHEMEX: `/md/v2/kline/last` and `/kline/list` both end one bar before now on every listing and
 * every timeframe, census 2026-10-23; its forming bar is WebSocket-only) therefore priced every call at the previous
 * close. For such a DECLARED venue the live price is its ticker's last price, which `getAssetContext` already fetches.
 *
 * Q10 = C: every NON-declared venue keeps `closes[closes.length - 1]`, byte-identical. A window there that lacks the
 * forming bar is a thin book with no trade yet in the interval, or the seconds after a bar boundary, and its newest
 * close IS the venue's own last trade (measured: Aster ZEN / FRAX / FORM / XCU close == ticker lastPrice). The
 * endpoint-omission class is kept out of those venues structurally instead: the adapters serve the forming bar
 * (Bitget young listings, WhiteBIT, CH3a), and scenario S plus the contiguity canary assert it on every venue's
 * references and go red the day a non-declared venue turns closed-only, or a declared one starts serving its
 * forming bar.
 */
import type { AssetContext, Candle, ExchangeId } from '../types.js';
import { StaleUpstreamWindowError } from './errors.js';

/** Venues whose public REST kline endpoints never carry the forming bar. One declaration, test-pinned. */
export const CLOSED_ONLY_KLINE_VENUES: readonly ExchangeId[] = Object.freeze(['PHEMEX'] as ExchangeId[]);

/** The oldest ticker a declared venue may be priced from. It bounds the ticker SNAPSHOT (Phemex `timestamp`, ns). */
export const LIVE_TICKER_MAX_AGE_MS = 60_000;

export function isClosedOnlyKlineVenue(venue: string): boolean {
  return (CLOSED_ONLY_KLINE_VENUES as readonly string[]).includes(venue);
}

/** The seconds after a bar boundary in which a venue may not show the new forming bar yet (no trade in it so far):
 *  one slot short is accepted there. Measured, CH3a census 2026-10-23 (`ch3a-boundary.out`). */
export const BOUNDARY_LAG_MS = 15_000;

const mod = (a: number, m: number) => ((a % m) + m) % m;

/**
 * The ONE judgement of a serving window's head, for contract scenario S and the live contiguity canary alike: null
 * when the newest bar is the one the venue's class owes — the FORMING bar (the slot holding `calledAtMs`, on the
 * venue's own phase) on every venue, forming − 1 on a declared closed-only kline venue — else why not. `toleranceMs`
 * widens the call instant for a replayed capture (its read completed up to that much later). Within BOUNDARY_LAG_MS
 * after a boundary one slot short is accepted. A declared venue that serves its forming bar is a FINDING (the
 * declaration is wrong), never a pass.
 */
export function formingHeadVerdict(newestOpenMs: number, servedMs: number, calledAtMs: number, venue: string, toleranceMs = 0): string | null {
  const declared = isClosedOnlyKlineVenue(venue);
  const owed = (at: number) => at - mod(at - newestOpenMs, servedMs) - (declared ? servedMs : 0);
  if (newestOpenMs === owed(calledAtMs) || newestOpenMs === owed(calledAtMs + toleranceMs)) return null;
  const forming = calledAtMs - mod(calledAtMs - newestOpenMs, servedMs);
  if (calledAtMs - forming <= BOUNDARY_LAG_MS && newestOpenMs === owed(calledAtMs) - servedMs) return null;
  if (declared && newestOpenMs === forming) return 'a declared closed-only kline venue served its forming bar';
  return `newest bar ${Math.round((forming - newestOpenMs) / servedMs)} slot(s) before the forming bar${declared ? ' (declared: 1 expected)' : ''}`;
}

/** null when a ticker last trade can price a call at `nowMs` (positive, finite, at most LIVE_TICKER_MAX_AGE_MS from
 *  now either way), else why not. livePriceOf and the canary's ticker probe both read it. */
export function tickerFreshness(t: AssetContext['lastTrade'], nowMs: number): string | null {
  if (!t || !Number.isFinite(t.price) || !(t.price > 0) || !Number.isFinite(t.atMs)) return 'its ticker carried no last price';
  if (Math.abs(nowMs - t.atMs) > LIVE_TICKER_MAX_AGE_MS) {
    return `its ticker is from ${new Date(t.atMs).toISOString()}, more than ${LIVE_TICKER_MAX_AGE_MS / 1000} s from now`;
  }
  return null;
}

export interface LivePriceWindow {
  coin: string;
  timeframe: string;
  /** Oldest-first, as get_trade_call sorts them. */
  candles: readonly Candle[];
  /** The step the venue serves `timeframe` on (tf-support `servedCandleStepMs`). */
  servedStepMs: number | null;
}

function refuse(w: LivePriceWindow, venue: ExchangeId, nowMs: number, why: string): never {
  const newest = w.candles[w.candles.length - 1];
  const step = w.servedStepMs != null && w.servedStepMs > 0 ? w.servedStepMs : null;
  const err = new StaleUpstreamWindowError({
    coin: w.coin,
    exchange: venue,
    timeframe: w.timeframe,
    newestBarAt: newest ? newest.time : nowMs,
    headGapBars: newest && step ? Math.max(0, Math.floor((nowMs - newest.time) / step) - 1) : 0,
    headStaleBars: 0,
  });
  err.message = `${w.coin} on ${venue} ${w.timeframe}: there is no live price — ${why}, so the call is refused.`;
  throw err;
}

/**
 * The live price of a call, in order:
 *   1. a non-declared venue: the newest bar's close (byte-identical to the pre-wave `closes[length - 1]`);
 *   2. a declared closed-only venue whose newest bar's interval contains now: that forming bar's close;
 *   3. a declared closed-only venue: the ticker's last price, when the ticker is at most LIVE_TICKER_MAX_AGE_MS old;
 *   4. otherwise refused with StaleUpstreamWindowError (before trackCall: never billed, never recorded).
 * Never the last closed bar of a declared venue.
 */
export function livePriceOf(
  window: LivePriceWindow,
  assetContext: Pick<AssetContext, 'lastTrade'>,
  venue: ExchangeId,
  nowMs: number,
): number {
  const newest = window.candles[window.candles.length - 1];
  if (!newest) refuse(window, venue, nowMs, 'the venue served no candle');
  if (!isClosedOnlyKlineVenue(venue)) return newest.close;

  const step = window.servedStepMs;
  if (step != null && step > 0 && newest.time <= nowMs && nowMs < newest.time + step) return newest.close;

  const stale = tickerFreshness(assetContext.lastTrade, nowMs);
  if (stale !== null) refuse(window, venue, nowMs, `the venue serves closed candles only and ${stale}`);
  return assetContext.lastTrade!.price;
}
