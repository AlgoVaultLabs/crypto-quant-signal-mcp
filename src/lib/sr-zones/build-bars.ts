/**
 * build-bars.ts — SR-ZONES-W3 R5 (Mr.1, 2026-11-20: "Build them first"). A timeframe a venue does not serve as that
 * exact bar is built from the venue's largest native timeframe that divides it; get-sr-zones.ts derives which (from the
 * adapters' served-interval maps, never a list). This module only builds, and is pure.
 *
 * Buckets open on UTC multiples of the requested step, as Binance's own bars do (8h at 00/08/16 UTC, 2h on even
 * hours): bucket = [open, open + step) with open % step === 0. Its constituents are the k = step / nativeStep native
 * bars opening at open, open + nativeStep, …, open + (k − 1)·nativeStep. A native bar inside a bucket but off its
 * slots (off its own UTC grid) fills no slot and makes that bucket a hole.
 *   - A CLOSED bucket (open + step ≤ nowMs) is built only when all k constituents are there. One missing is a hole: the
 *     bucket is left out, never served as a partial bar, and the window treats it as it treats a hole in native bars.
 *   - The FORMING bucket (open ≤ nowMs < open + step) follows the native forming-bar rule: it is built from the
 *     constituents read so far, which run without a gap from its open (the first is the bucket's open bar).
 *   - A bucket that opens after nowMs is not built.
 * Open = the first constituent's open, high = the max, low = the min, close = the last constituent's close, volume =
 * the sum (in time order). A step the native step does not divide evenly builds nothing. Output ascending.
 */
import type { Candle } from '../../types.js';

export function buildBars(native: readonly Candle[], nativeStepMs: number, requestedStepMs: number, nowMs: number): Candle[] {
  const k = requestedStepMs / nativeStepMs;
  if (!(nativeStepMs > 0) || !Number.isInteger(k) || k < 1) return [];
  const bySlot = new Map<number, Candle>();
  for (const c of native) bySlot.set(c.time, c);
  const held = new Map<number, number>(); // bucket open → distinct native bars inside it
  for (const t of bySlot.keys()) {
    const open = t - (t % requestedStepMs);
    held.set(open, (held.get(open) ?? 0) + 1);
  }
  const out: Candle[] = [];
  for (const open of [...held.keys()].sort((a, b) => a - b)) {
    if (open > nowMs) continue;
    const forming = nowMs < open + requestedStepMs;
    const parts: Candle[] = [];
    for (let i = 0; i < k; i++) {
      const c = bySlot.get(open + i * nativeStepMs);
      if (c === undefined) break;
      parts.push(c);
    }
    // Closed: every slot, nothing else inside. Forming: a run from the open, nothing inside it but that run.
    if (parts.length === 0 || parts.length !== held.get(open) || (!forming && parts.length < k)) continue;
    let high = parts[0].high;
    let low = parts[0].low;
    let volume = 0;
    for (const p of parts) {
      if (p.high > high) high = p.high;
      if (p.low < low) low = p.low;
      volume += p.volume;
    }
    out.push({ time: open, open: parts[0].open, high, low, close: parts[parts.length - 1].close, volume });
  }
  return out;
}
