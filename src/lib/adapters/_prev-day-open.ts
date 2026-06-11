/**
 * 24h-prior ("open") price reconstruction for the OI/momentum priceChange in
 * get-trade-call.ts: `priceChange = (currentPrice - prevDayPx) / prevDayPx`.
 *
 * Several perp venues do NOT expose a 24h-open field on their ticker. Using the
 * 24h-LOW (price ≥ low almost always → priceChange almost always positive) or
 * the CURRENT price (priceChange ≈ 0) as prevDayPx biases the trade-call score
 * systematically. This reconstructs the true 24h-open.
 *
 * `changeFraction` is the venue's 24h change as a FRACTION (0.0055 = +0.55%),
 * already normalized by the caller. NOTE the per-venue scale divergence
 * (never assume cross-venue uniformity — verified live 2026-06-11):
 *   - WEEX `priceChangePercent`, KuCoin `priceChgPct`, MEXC `riseFallRate`
 *     are FRACTIONS — pass as-is.
 *   - Gate `change_percentage` is a percent-NUMBER (e.g. "5.2") — a caller using
 *     that field must divide by 100 first.
 * Venues with no change field at all (Bitmart, WhiteBIT) derive the open from a
 * kline and use this only for the hi/lo-midpoint fallback (pass changeFraction
 * = NaN).
 *
 * Extends the BINANCE prevClosePrice→openPrice fix (OPS-TRADE-CALL-CLUSTER-W1)
 * to the remaining shadow venues.
 *
 * Fallback order: change-reconstruction → hi/lo midpoint (unbiased) → last.
 * Never returns the 24h-low or the current price alone.
 */
export function reconstructPrevDayOpen(
  last: number,
  changeFraction: number,
  high?: number,
  low?: number,
): number {
  if (Number.isFinite(changeFraction) && Number.isFinite(last) && last > 0) {
    const denom = 1 + changeFraction;
    if (denom > 0) return last / denom; // open = last / (1 + 24h-change-fraction)
  }
  // Unbiased fallback: midpoint of the 24h range (equally likely above/below open).
  if (
    typeof high === 'number' && typeof low === 'number' &&
    Number.isFinite(high) && Number.isFinite(low) && high > 0 && low > 0
  ) {
    return (high + low) / 2;
  }
  // Last resort: current price (priceChange → 0, neutral). Never the 24h-low.
  return Number.isFinite(last) && last > 0 ? last : 0;
}
