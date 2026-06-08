/**
 * TRADE-CALL-ROUTING-RESOLVER-W1 R2 — shared trade-call dispatch.
 *
 * The single-derivation point both `get_trade_call` and `get_equity_call` route
 * through: resolve the market route ONCE (a pure function of the params), then
 * dispatch to the EXISTING perp engine (`getTradeSignal`) or equity engine
 * (`getEquityCall`). Because the route is computed in one place and both entry
 * points project from it, the calling model picking either tool yields the
 * contract-correct engine — the "two overlapping trade-call tools" mis-route is
 * retired structurally.
 *
 * Lazy: the equity-universe membership check (the one async edge) fires ONLY when
 * the call is bare (no venue, no timeframe, no assetClass) — when any of those is
 * present the route is perp/forced regardless, so a `{BTC, BINANCE, 15m}` call
 * adds zero DB latency.
 */
import { resolveMarketRoute, type MarketRoute } from '../lib/market-route.js';
import { isEquityUniverseSymbol } from '../lib/equities/equity-universe-membership.js';
import { getTradeSignal } from './get-trade-call.js';
import { getEquityCall } from '../lib/equities/equity-tool-formatters.js';
import type { ExchangeId, LicenseInfo } from '../types.js';

export interface TradeCallRouteParams {
  /** Ticker — crypto asset or US stock/ETF. */
  coin: string;
  /** Caller-supplied timeframe (undefined when omitted). */
  timeframe?: string;
  /** Caller-supplied crypto venue (undefined when omitted). */
  exchange?: ExchangeId;
  /** Explicit engine override ('perp' | 'equity'). */
  assetClass?: 'perp' | 'equity';
  /** Include perp reasoning (defaults true; ignored by the equity engine). */
  includeReasoning?: boolean;
  license?: LicenseInfo;
}

/** Resolve the route (lazy universe check), dispatch, return the engine result + route. */
export async function routeTradeCall(
  params: TradeCallRouteParams,
): Promise<{ route: MarketRoute; result: unknown }> {
  const { coin, timeframe, exchange, assetClass, includeReasoning, license } = params;

  // Lazy: membership matters only in the bare branch.
  const bare = !exchange && !timeframe && !assetClass;
  const inEquityUniverse = bare ? await isEquityUniverseSymbol(coin) : undefined;

  const route = resolveMarketRoute({ symbol: coin, exchange, timeframe, assetClass, inEquityUniverse });

  if (route.engine === 'equity') {
    // The equity engine is daily-bar + venue-less; it owns its own quota (HOLD-free).
    const result = await getEquityCall({ symbol: coin, license });
    return { route, result };
  }

  // Perp engine — the resolved route always carries a concrete venue + timeframe.
  const result = await getTradeSignal({
    coin,
    timeframe: route.timeframe,
    includeReasoning: includeReasoning ?? true,
    exchange: route.exchange,
    license,
  });
  return { route, result };
}
