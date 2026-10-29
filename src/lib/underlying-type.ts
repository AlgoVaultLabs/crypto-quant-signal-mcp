/**
 * Underlying-type resolver (TRADIFI-SIGNAL-HARDENING-W1, R2).
 *
 * Maps a (coin, exchange) to its underlying AssetClass for session + funding
 * interpretation. OPS-ASSET-CLASS-TOTALITY-W1: a pure PROJECTION of the asset-class
 * engine (`asset-class-detection.ts`) on every venue — Binance included. The
 * Binance-only second `exchangeInfo` read and its `underlyingType` tag lookup are
 * retired: the engine's Binance detector reads the same field once, through the one
 * tag table, so a class the venue publishes can no longer be dropped here (E1: HK/CN
 * equities and FX resolved UNKNOWN).
 *
 * Degradation is the engine's: live snapshot → stale snapshot → STATIC seed floor.
 * Floor: a coin the engine knows nothing about is 'UNKNOWN' when it is a known
 * TradFi symbol (renders NO caveat — never assert a class we cannot substantiate),
 * else 'CRYPTO'. `resolveAssetClass` NEVER throws.
 */
import { isKnownTradFi } from './asset-tiers.js';
import { getAssetClass, warmAssetClasses } from './asset-class-detection.js';
import type { AssetClass } from './market-sessions-constants.js';
import type { ExchangeId } from '../types.js';

/** Resolver output: a concrete class, or 'UNKNOWN' when it cannot be substantiated. */
export type ResolvedAssetClass = AssetClass | 'UNKNOWN';

/** Resolve the underlying AssetClass for a coin on a venue. Never throws. */
export async function resolveAssetClass(coin: string, exchange: ExchangeId): Promise<ResolvedAssetClass> {
  const symbol = coin.toUpperCase();
  try {
    await warmAssetClasses(); // gated + cheap; a no-op under vitest unless detectors are injected
  } catch {
    // defensive — the warm is already fail-open; the engine serves its prior/static state.
  }
  const cls = getAssetClass(symbol, exchange);
  if (cls) return cls;
  return isKnownTradFi(symbol) ? 'UNKNOWN' : 'CRYPTO';
}
