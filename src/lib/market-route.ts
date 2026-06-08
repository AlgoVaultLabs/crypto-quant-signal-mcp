/**
 * TRADE-CALL-ROUTING-RESOLVER-W1 R1 — the single market-route resolver.
 *
 * Makes the composite trade call route DETERMINISTICALLY by parameters, so the
 * engine is correct regardless of which tool the calling model picks: both
 * `get_trade_call` and `get_equity_call` dispatch through `resolveMarketRoute`
 * (single-derivation — the route is computed once and every entry point projects
 * from it). Adding a future asset class plugs into this one resolver + one
 * truth-table test, with no per-tool branching.
 *
 * PURE / deterministic / side-effect-free. Equity-universe membership is the only
 * classifier needed (a bare ticker in the Databento universe → stocks; everything
 * else → perp); it is INJECTED as `inEquityUniverse` (resolved by the handler-side
 * async universe check — the existing shared SoT, no parallel list) and is
 * consulted ONLY in the bare branch, so a venue/timeframe/assetClass call needs no
 * DB lookup at all.
 */
import type { ExchangeId } from '../types.js';

/** Which engine a call resolves to. */
export type MarketEngine = 'perp' | 'equity';

export interface MarketRouteInput {
  /** The ticker (e.g. BTC, TSLA). Crypto asset or US stock/ETF. */
  symbol: string;
  /** Caller-supplied crypto venue. `undefined` when the caller omitted it. */
  exchange?: ExchangeId;
  /** Caller-supplied candle timeframe. `undefined` when the caller omitted it. */
  timeframe?: string;
  /** Explicit engine override ('perp' | 'equity') — forces the engine. */
  assetClass?: MarketEngine;
  /**
   * Whether `symbol` is in the equity universe. Resolved by the caller (the
   * handler-side async universe check) and consulted ONLY in the bare branch
   * (no exchange, no timeframe, no assetClass). Leave undefined otherwise.
   */
  inEquityUniverse?: boolean;
}

export interface MarketRoute {
  engine: MarketEngine;
  /** Present for perp routes; absent for equity (equity is daily-bar, venue-less). */
  exchange?: ExchangeId;
  /** Always concrete — '1d' for equity; the resolved timeframe for perp. */
  timeframe: string;
}

/** Default perp timeframe when none is named. */
const DEFAULT_PERP_TIMEFRAME = '15m';
/** Equity verdicts are always daily-bar. */
const EQUITY_TIMEFRAME = '1d';

/**
 * Default perp venue for a symbol — `BINANCE` for ALL symbols, stock tickers
 * included (no per-symbol venue special-casing). If the resolved venue does not
 * list the requested perp (e.g. a tokenized stock not on Binance), the perp
 * engine returns its standard structured not-found error with suggested venues,
 * and the caller names a venue that lists it (e.g. exchange=BITGET).
 */
export function venueDefault(_symbol: string): ExchangeId {
  return 'BINANCE';
}

/**
 * Resolve a call to its engine + venue + timeframe, in spec order:
 *   1. assetClass forces the engine.
 *   2. a named crypto venue → perp.
 *   3. a named timeframe → perp (default venue).
 *   4. bare (no venue/TF/assetClass) → equity if in the equity universe, else perp.
 */
export function resolveMarketRoute(input: MarketRouteInput): MarketRoute {
  const { symbol, exchange, timeframe, assetClass, inEquityUniverse } = input;

  // 1. Explicit assetClass wins.
  if (assetClass === 'equity') {
    return { engine: 'equity', timeframe: EQUITY_TIMEFRAME };
  }
  if (assetClass === 'perp') {
    return { engine: 'perp', exchange: exchange ?? venueDefault(symbol), timeframe: timeframe ?? DEFAULT_PERP_TIMEFRAME };
  }

  // 2. A named crypto venue → perp on that venue.
  if (exchange) {
    return { engine: 'perp', exchange, timeframe: timeframe ?? DEFAULT_PERP_TIMEFRAME };
  }

  // 3. A named timeframe (no venue) → perp on the default venue.
  if (timeframe) {
    return { engine: 'perp', exchange: venueDefault(symbol), timeframe };
  }

  // 4. Bare — equity-universe membership decides (perp is the fail-open default).
  if (inEquityUniverse) {
    return { engine: 'equity', timeframe: EQUITY_TIMEFRAME };
  }
  return { engine: 'perp', exchange: venueDefault(symbol), timeframe: DEFAULT_PERP_TIMEFRAME };
}
