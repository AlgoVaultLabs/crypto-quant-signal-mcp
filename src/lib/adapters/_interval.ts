/**
 * _interval.ts — OPS-SERVED-CANDLE-TRUTH-W1 CH2. The ONE interval lookup every adapter's `getCandles` makes, first,
 * before any request: the venue's own token for a timeframe, or a typed refusal.
 *
 * It replaces fourteen `INTERVAL_MAP[interval] || '<default>'` sites and two `?? <default>` ones. Each turned a
 * timeframe its venue does not serve into a request for the adapter's default bar — usually 1h — and handed the
 * caller those bars labelled as the timeframe it asked for. tests/unit/adapter-interval-fallback-gate.test.ts keeps
 * the pattern out of src/lib/adapters.
 *
 * The adapter's map stays the single source of what it serves: `servedIntervalMs` (served-interval.ts) is built from
 * the same map, so the refusal, the seeder's skip (tf-support `isTimeframeFaithful`) and the tools' up-front
 * `timeframe_unserved` can never disagree.
 */
import { TimeframeUnservedError } from '../errors.js';
import { TIMEFRAMES } from '../capabilities.js';

/** The product timeframes `map` serves, in the product's order (TIMEFRAMES). A venue token for a timeframe the
 *  product never asks for (BingX `6h`) is not listed. */
export function servedTimeframesOf(map: Readonly<Record<string, unknown>>): string[] {
  return TIMEFRAMES.filter((tf) => Object.hasOwn(map, tf));
}

/** `map[tf]`, or `TimeframeUnservedError` when the venue does not serve `tf`. Own keys only, so a timeframe named
 *  like an Object.prototype member resolves to nothing. */
export function resolveVenueInterval<T extends string | number>(map: Readonly<Record<string, T>>, tf: string, exchange: string): T {
  if (Object.hasOwn(map, tf)) return map[tf];
  throw new TimeframeUnservedError({ exchange, timeframe: tf, servedTimeframes: servedTimeframesOf(map) });
}
