/**
 * live-price.ts — OPS-SERVED-CANDLE-TRUTH-W1 CH3a (Cowork Q8; Mr.1 Q10 = C; Cowork Q11 / Q13 = A). The ONE derivation
 * of a call's LIVE price: `currentPrice` in src/tools/get-trade-call.ts, which is the reported price, the track-record
 * entry price and the value `recordSignal` stores. Scans and the seeder reach it through `getTradeSignal`;
 * `recordSignal` has no other caller.
 *
 * Why it exists: under CANDLE_BASIS=closed the verdict reads closed bars only (splitCandleWindow), so a candle window
 * that lacks the venue's forming bar costs exactly one thing, the entry price. Two kinds of venue cannot be priced from
 * their candles, and each is DECLARED below with its kind:
 *   - CLOSED_ONLY (PHEMEX): `/md/v2/kline/last` and `/kline/list` both end one bar before now on every listing and
 *     every timeframe (census 2026-10-23; its forming bar is WebSocket-only), so every call was priced at the previous
 *     close.
 *   - SNAPSHOT_KLINE (ASTER): `/fapi/v1/klines` answers a snapshot the origin refreshes every ~70–90 s (measured on
 *     signal-1 2026-10-23 10:47–10:52Z and from a cloud vantage 16:28–16:30Z, `x-cache: Miss from cloudfront` on every
 *     read): the BTC 1m close sat frozen for 78 s while the last trade moved, and the forming bar is absent on 57–60 %
 *     of 1m reads (≤ 2 slots), 20–23 % of 3m reads. Even a forming close there can be ~90 s old.
 * A declared venue is priced from its ticker's last trade ALWAYS (never a candle close, even with a forming bar
 * present), from the response `getAssetContext` already fetches.
 *
 * Q10 = C: every NON-declared venue keeps `closes[closes.length - 1]`, byte-identical. A window there that lacks the
 * forming bar is a thin book with no trade yet in the interval, or the seconds after a bar boundary, and its newest
 * close is the venue's own last trade. (The premise was first measured on four thin ASTER books, where a frozen close
 * equals the last trade trivially; liquid ASTER books falsified it, which is why ASTER is declared.) The
 * endpoint-omission class is kept out of those venues structurally instead: the adapters serve the forming bar
 * (Bitget young listings, WhiteBIT, CH3a), and scenario S plus the contiguity canary assert it on every venue's
 * references and go red the day a non-declared venue turns closed-only, or a declared one starts serving its
 * forming bar.
 */
import type { AssetContext, Candle, ExchangeId } from '../types.js';
import { StaleUpstreamWindowError } from './errors.js';

/** Why a venue is priced from its ticker: its klines never hold the forming bar, or they are a lagging snapshot. */
export type TickerPricedKind = 'CLOSED_ONLY' | 'SNAPSHOT_KLINE';

/** The ONE declaration of ticker-priced venues, each with its kind (test-pinned). The kind drives the head rule and
 *  the ticker check; a future venue joins here with its kind — there is no second list. */
export const TICKER_PRICED_VENUES: Readonly<Partial<Record<ExchangeId, TickerPricedKind>>> = Object.freeze({
  PHEMEX: 'CLOSED_ONLY',
  ASTER: 'SNAPSHOT_KLINE',
});

export function tickerPricedKind(venue: string): TickerPricedKind | null {
  return Object.prototype.hasOwnProperty.call(TICKER_PRICED_VENUES, venue) ? TICKER_PRICED_VENUES[venue as ExchangeId] ?? null : null;
}

export function isTickerPricedVenue(venue: string): boolean {
  return tickerPricedKind(venue) !== null;
}

/** Venues whose public REST kline endpoints never carry the forming bar — derived from TICKER_PRICED_VENUES (sorted, so
 *  no consumer depends on the object's key order). */
export const CLOSED_ONLY_KLINE_VENUES: readonly ExchangeId[] = Object.freeze(
  (Object.keys(TICKER_PRICED_VENUES) as ExchangeId[]).filter((v) => TICKER_PRICED_VENUES[v] === 'CLOSED_ONLY').sort(),
);

export function isClosedOnlyKlineVenue(venue: string): boolean {
  return tickerPricedKind(venue) === 'CLOSED_ONLY';
}

/** The oldest ticker a CLOSED_ONLY venue may be priced from. It bounds the ticker SNAPSHOT (Phemex `timestamp`, ns).
 *  A SNAPSHOT_KLINE ticker carries the last TRADE's time instead, and is not age-bounded (see tickerFreshness). */
export const LIVE_TICKER_MAX_AGE_MS = 60_000;

/** A SNAPSHOT_KLINE venue's newest served bar may have closed at most this long before the read: the measured
 *  snapshot refresh (ASTER, ~70–90 s, 2026-10-23). It is also the ruling's slot bound (newest open ≥ forming − 2):
 *  a head 3 slots short closed ≥ 2 steps ≥ 120 s before the read on every served step, so one bound holds both.
 *  Beyond it the snapshot is staler than the venue was ever measured to serve. */
export const SNAPSHOT_KLINE_MAX_LAG_MS = 90_000;

/** The seconds after a bar boundary in which a venue may not show the new bar yet: one slot short is accepted there.
 *  A VENUE-lag bound. Basis: the CH3a-R2 boundary census (2026-10-24 10:22–10:37Z, 13 non-declared venues × 12
 *  boundaries through the getAdapter seam, vault `ch3a-r2-venue-boundary-summary.out`): every venue but KuCoin served
 *  its BTC forming bar ≤ 7.0 s after the boundary (HL 7.0, BINANCE 6.0, BITGET 4.0, OKX 3.0, BINGX 2.0, BYBIT and
 *  MEXC 1.0). KuCoin's later bars (BTC up to 18.0 s) and HL's young-listing short heads are a bar that has not TRADED
 *  yet, not lag: paired with each venue's trade feed, none of 73 short heads had a trade after the newest served bar
 *  (`ch3a-r2-kucoin-trade-head.jsonl`, `ch3a-r2-hl-soxl-trade-head.jsonl`). Those venues are TRADE_GATED_KLINE_VENUES,
 *  judged past this bound by their trades; it is also their trade → kline propagation bound. It is not a
 *  SNAPSHOT_KLINE venue's bound (ASTER ran to 53.7 s there): that is SNAPSHOT_KLINE_MAX_LAG_MS. */
export const BOUNDARY_LAG_MS = 15_000;

/** The same allowance on a CLOSED_ONLY venue's liquid reference, where the owed head is forming − 1 and the
 *  just-closed bar is what may be late. Measured: PHEMEX BTCUSDT `/md/v2/kline/last` on signal-1, 1 s polls,
 *  2026-10-23 16:43–17:13Z — the just-closed 1m / 5m bar first appeared 4.5–25.9 s after its boundary (36
 *  boundaries; 7 of 30 1m ones past 15 s; vault `ch3a-r1-phemex-btc-boundary*.jsonl`). */
export const CLOSED_ONLY_BOUNDARY_LAG_MS = 30_000;

const mod = (a: number, m: number) => ((a % m) + m) % m;

/** Which reference a head is judged on: the LIQUID one (BTC, which trades every bar) or a young/thin listing. */
export type HeadReference = 'liquid' | 'thin';

/** Venues whose klines serve a bar only once it has TRADED (Cowork Q14 = A; measured 2026-10-24, see BOUNDARY_LAG_MS):
 *  a head short of the forming bar there is "no trade yet" unless the venue's own trades say a later bar traded. Its OWN
 *  declaration, not a TickerPricedKind: livePriceOf never reads it, so these venues stay priced from their newest close,
 *  which on a short head is already the last trade. Only formingHeadVerdict reads it (test-pinned). */
export const TRADE_GATED_KLINE_VENUES = Object.freeze(['HL', 'KUCOIN'] as const);
export type TradeGatedKlineVenue = (typeof TRADE_GATED_KLINE_VENUES)[number];

export function isTradeGatedKlineVenue(venue: string): venue is TradeGatedKlineVenue {
  return (TRADE_GATED_KLINE_VENUES as readonly string[]).includes(venue);
}

/** One venue print, as a trade-gated venue's recent-trades read returns it (order is not used). */
export interface TradePrint { price: number; atMs: number }

/** What a trade-gated short head is judged with: the venue's recent trades, or why they could not be read. */
export type HeadTrades = readonly Pick<TradePrint, 'atMs'>[] | { error: string };

/** formingHeadVerdict's third outcome: the head could not be judged. Only a trade-gated venue's short head answers
 *  it, when its trades were not read, could not be read, came back empty, or do not reach back to the newest served
 *  bar's slot end. Never accepted, never a FAIL. */
export interface HeadIndeterminate { indeterminate: string }

/** null: a head the venue may serve; a string: why it may not (FAIL); HeadIndeterminate: it could not be judged. */
export type HeadVerdict = string | null | HeadIndeterminate;

export function isHeadIndeterminate(v: HeadVerdict): v is HeadIndeterminate {
  return v !== null && typeof v === 'object';
}

/** A trade-gated venue's head `slotsShort` (> 0) slots short past every slot-based allowance: FAIL iff a returned
 *  trade sits at or after the newest served bar's slot end (a later bar traded) and more than BOUNDARY_LAG_MS before
 *  the call (trade → kline propagation); else accepted, but only when the trades reach back before that slot end —
 *  a recent-trades list is capped (HL returns 10: 14.9 s of BTC, 2026-10-24), and one that starts after the slot end
 *  cannot show that nothing traded there. */
function tradeGatedHead(newestOpenMs: number, servedMs: number, calledAtMs: number, slotsShort: number, trades: HeadTrades | undefined): HeadVerdict {
  const head = `newest bar ${slotsShort} slot(s) before the forming bar on a trade-gated venue`;
  if (trades === undefined) return { indeterminate: `${head}, and its trades were not read` };
  if ('error' in trades) return { indeterminate: `${head}, and its trades could not be read: ${trades.error}` };
  const at = trades.map((t) => t.atMs).filter(Number.isFinite);
  if (at.length === 0) return { indeterminate: `${head}, and its trade read came back empty` };
  const slotEndMs = newestOpenMs + servedMs;
  const late = at.filter((t) => t >= slotEndMs && calledAtMs - t > BOUNDARY_LAG_MS);
  if (late.length > 0) {
    return `${head}, and it traded ${Math.round((calledAtMs - Math.min(...late)) / 1000)} s before the read in a later slot (a traded bar is missing)`;
  }
  if (Math.min(...at) >= slotEndMs) {
    return { indeterminate: `${head}, and its ${at.length} recent trades do not reach back to the newest served bar's slot end` };
  }
  return null;
}

/** How far a served head sits from the one the venue's class owes. `slots`: owed − newest in served steps (0 = as
 *  owed; −1 = a CLOSED_ONLY venue served its forming bar). `ageMs`: how long before `calledAtMs` the newest served bar
 *  closed (0 while it is still forming). The canary records both as metrics. */
export function headLag(newestOpenMs: number, servedMs: number, calledAtMs: number, venue: string): { slots: number; ageMs: number } {
  const forming = calledAtMs - mod(calledAtMs - newestOpenMs, servedMs);
  const owedOpen = forming - (isClosedOnlyKlineVenue(venue) ? servedMs : 0);
  return { slots: Math.round((owedOpen - newestOpenMs) / servedMs), ageMs: Math.max(0, calledAtMs - (newestOpenMs + servedMs)) };
}

/**
 * The ONE judgement of a serving window's head, for contract scenario S and the live contiguity canary alike: null
 * when the head is one the venue's class may serve, else why not (FAIL), or HeadIndeterminate when it cannot be judged
 * (a trade-gated short head only). `toleranceMs` widens the call instant for a replayed capture (its read completed up
 * to that much later). `trades` is read only on a trade-gated venue's short head; the caller reads them when, and
 * only when, a call without them answers HeadIndeterminate.
 *   - a non-declared venue owes its FORMING bar (the slot holding `calledAtMs`, on the venue's own phase); within
 *     BOUNDARY_LAG_MS after a boundary one slot short is accepted; past that, a TRADE_GATED_KLINE_VENUES head (Q14,
 *     liquid or thin reference) is judged by the venue's `trades` (tradeGatedHead), and is INDETERMINATE when they
 *     cannot judge it;
 *   - a SNAPSHOT_KLINE venue (Q11) may serve its forming bar, or on the LIQUID reference a head whose newest bar
 *     closed at most SNAPSHOT_KLINE_MAX_LAG_MS before the read; on a young/thin reference any older head is a metric
 *     (headLag), never a FAIL;
 *   - a CLOSED_ONLY venue (Q13) FAILS when it serves its forming bar (the declaration is wrong); on the LIQUID
 *     reference its head is exactly forming − 1 (one slot more within CLOSED_ONLY_BOUNDARY_LAG_MS after a boundary); on a
 *     young/thin reference any older head is a metric (headLag), never a FAIL — the call is priced from the ticker.
 */
export function formingHeadVerdict(
  newestOpenMs: number, servedMs: number, calledAtMs: number, venue: string, toleranceMs = 0, reference: HeadReference = 'liquid',
  trades?: HeadTrades,
): HeadVerdict {
  const kind = tickerPricedKind(venue);
  const forming = calledAtMs - mod(calledAtMs - newestOpenMs, servedMs);
  const slotsShort = Math.round((forming - newestOpenMs) / servedMs);
  if (kind === 'SNAPSHOT_KLINE') {
    if (slotsShort <= 0 && newestOpenMs <= calledAtMs + toleranceMs) return null;
    const ageMs = calledAtMs - (newestOpenMs + servedMs);
    if (slotsShort > 0 && reference === 'thin') return null;
    if (slotsShort > 0 && ageMs <= SNAPSHOT_KLINE_MAX_LAG_MS + toleranceMs) return null;
    return `newest bar ${slotsShort} slot(s) before the forming bar, closed ${Math.round(ageMs / 1000)} s before the read (snapshot kline: ≤ ${SNAPSHOT_KLINE_MAX_LAG_MS / 1000} s accepted)`;
  }
  const declared = kind === 'CLOSED_ONLY';
  const owed = (at: number) => at - mod(at - newestOpenMs, servedMs) - (declared ? servedMs : 0);
  if (newestOpenMs === owed(calledAtMs) || newestOpenMs === owed(calledAtMs + toleranceMs)) return null;
  if (declared && newestOpenMs >= forming) return 'a declared closed-only kline venue served its forming bar';
  if (declared && reference === 'thin') return null;
  const boundaryLagMs = declared ? CLOSED_ONLY_BOUNDARY_LAG_MS : BOUNDARY_LAG_MS;
  if (calledAtMs - forming <= boundaryLagMs && newestOpenMs === owed(calledAtMs) - servedMs) return null;
  if (!declared && slotsShort > 0 && isTradeGatedKlineVenue(venue)) return tradeGatedHead(newestOpenMs, servedMs, calledAtMs, slotsShort, trades);
  return `newest bar ${slotsShort} slot(s) before the forming bar${declared ? ' (declared: 1 expected)' : ''}`;
}

/** null when a ticker can price a call on `venue` at `nowMs`, else why not. livePriceOf and the canary's ticker probe
 *  both read it. Every kind needs a positive, finite last price. CLOSED_ONLY: the ticker SNAPSHOT is at most
 *  LIVE_TICKER_MAX_AGE_MS from now either way. SNAPSHOT_KLINE: no age bound — its time is the last TRADE's, and a thin
 *  book's last trade can be hours old and still be its live price. */
export function tickerFreshness(t: AssetContext['lastTrade'], nowMs: number, venue: string): string | null {
  if (!t || !Number.isFinite(t.price) || !(t.price > 0)) return 'its ticker carried no last price';
  if (tickerPricedKind(venue) === 'SNAPSHOT_KLINE') return null;
  if (!Number.isFinite(t.atMs)) return 'its ticker carried no last price';
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

const KIND_WHY: Record<TickerPricedKind, string> = {
  CLOSED_ONLY: 'the venue serves closed candles only',
  SNAPSHOT_KLINE: 'the venue serves a lagging candle snapshot',
};

/**
 * The live price of a call:
 *   1. a non-declared venue: the newest bar's close (byte-identical to the pre-wave `closes[length - 1]`);
 *   2. a declared venue (TICKER_PRICED_VENUES): the ticker's last trade, ALWAYS — never a candle close, even when a
 *      forming bar is present — when tickerFreshness accepts it for the venue's kind;
 *   3. otherwise refused with StaleUpstreamWindowError (before trackCall: never billed, never recorded).
 * A window with no candle is refused on every venue.
 */
export function livePriceOf(
  window: LivePriceWindow,
  assetContext: Pick<AssetContext, 'lastTrade'>,
  venue: ExchangeId,
  nowMs: number,
): number {
  const newest = window.candles[window.candles.length - 1];
  if (!newest) refuse(window, venue, nowMs, 'the venue served no candle');
  const kind = tickerPricedKind(venue);
  if (kind === null) return newest.close;

  const stale = tickerFreshness(assetContext.lastTrade, nowMs, venue);
  if (stale !== null) refuse(window, venue, nowMs, `${KIND_WHY[kind]} and ${stale}`);
  return assetContext.lastTrade!.price;
}
