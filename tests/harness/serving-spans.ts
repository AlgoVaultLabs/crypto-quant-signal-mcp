/**
 * serving-spans.ts — OPS-SERVED-CANDLE-TRUTH-W1 CH1: the distinct serving windows the product asks a venue for on one
 * timeframe, in ms back from now, read by the differential (Bitget/OKX on the synthetic venue) and by contract-suite
 * scenario S (every other venue's captured SERVING.json, whose coverage it checks).
 *
 * The derivation itself moved to src/lib/serving-windows.ts (`servingSpans`) in CH2, so the live canary's S probes
 * read the same one. This keeps the tests' (tf, served) form: a `requested` window's step is TF_MS[tf].
 */
import { servingSpans as spansOf, type ServingSpan } from '../../src/lib/serving-windows.js';
import { TF_MS } from '../../src/lib/pfe-mae.js';

export type { ServingSpan };

export function servingSpans(tf: string, servedStepMs: number | null): ServingSpan[] {
  return spansOf(tf, servedStepMs, TF_MS[tf]);
}
