/**
 * serving-spans.ts — OPS-SERVED-CANDLE-TRUTH-W1 CH1: the distinct serving windows the product asks a venue for on one
 * timeframe, in ms back from now. ONE derivation, read by the differential (Bitget/OKX on the synthetic venue) and by
 * contract-suite scenario S (every other venue's captured SERVING.json, whose coverage it checks).
 *
 * A `requested` window spans bars × the requested step; a `served` window spans bars × the venue's own served step
 * (src/lib/serving-windows.ts). Consumers whose windows span the same time share one read, so they share one entry,
 * labelled `consumer@bars+consumer@bars` in registry order.
 */
import { servingWindowsFor } from '../../src/lib/serving-windows.js';
import { TF_MS } from '../../src/lib/pfe-mae.js';

export interface ServingSpan { label: string; spanMs: number }

export function servingSpans(tf: string, servedStepMs: number | null): ServingSpan[] {
  const seen = new Map<number, string>();
  for (const w of servingWindowsFor(tf)) {
    const step = w.unit === 'served' ? (servedStepMs ?? TF_MS[tf]) : TF_MS[tf];
    const spanMs = w.bars * step;
    seen.set(spanMs, seen.has(spanMs) ? `${seen.get(spanMs)}+${w.consumer}@${w.bars}` : `${w.consumer}@${w.bars}`);
  }
  return [...seen].map(([spanMs, label]) => ({ label, spanMs }));
}
