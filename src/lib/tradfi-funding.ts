/**
 * TradFi funding interpretation (TRADIFI-SIGNAL-HARDENING-W1, R4).
 *
 * Pure mapping from an underlying AssetClass to the funding annotation our
 * tools surface. The numeric funding rate is correct already; what was missing
 * is INTERPRETATION:
 *  - PREMARKET (pre-IPO) funding is administratively FIXED (+0.005%/8h on
 *    Binance) until the IPO transition — it is NOT a market-sentiment signal,
 *    so we override `funding_state` to a dedicated FIXED_PREIPO bucket.
 *  - EQUITY / KR_EQUITY / COMMODITY perp funding has a 0% interest component
 *    (vs crypto's 0.01%/day) and is structurally near-zero; small absolute
 *    values are normal and should not be read as crowd pressure.
 *  - CRYPTO / UNKNOWN: no annotation (existing crypto thresholds untouched).
 */
import type { AssetClass } from './market-sessions-constants.js';
import { FUNDING_NOTE_PREIPO, FUNDING_NOTE_TRADFI } from './market-sessions-constants.js';
import type { FundingState } from './indicator-buckets.js';
import type { ExchangeId, DexType, CrossVenueFundingSentiment } from '../types.js';
import { getAdapter } from './exchange-adapter.js';
import { getVenuesSupporting } from './venue-coverage.js';
import { getDexForCoin } from './asset-tiers.js';
import { toBinanceSymbol } from './adapters/binance.js';
import { toBybitSymbol } from './adapters/bybit.js';
import { toBitgetSymbol } from './adapters/bitget.js';

export interface FundingAnnotation {
  /** When set, REPLACES the z-score-bucketed funding_state (PREMARKET → FIXED_PREIPO). */
  fundingStateOverride: FundingState | null;
  /** One-liner appended to `indicators.funding_note`; null = omit the field. */
  fundingNote: string | null;
}

/**
 * Resolve the funding annotation for an asset class. `'UNKNOWN'` (resolver
 * could not classify) is treated like CRYPTO: no annotation.
 */
export function tradfiFundingAnnotation(assetClass: AssetClass | 'UNKNOWN'): FundingAnnotation {
  switch (assetClass) {
    case 'PREMARKET':
      return { fundingStateOverride: 'FIXED_PREIPO', fundingNote: FUNDING_NOTE_PREIPO };
    case 'EQUITY':
    case 'KR_EQUITY':
    case 'COMMODITY':
      return { fundingStateOverride: null, fundingNote: FUNDING_NOTE_TRADFI };
    case 'CRYPTO':
    case 'UNKNOWN':
    default:
      return { fundingStateOverride: null, fundingNote: null };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Cross-venue TradFi funding aggregation (OPS-TRADFI-XVENUE-FUNDING-W1, R2)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Date the per-venue TradFi funding coverage + calibration was last probed
 * live. Distinct from `venue-coverage.ts`'s `COVERAGE_PROBED_AT` (which dates
 * the venue MATRIX); this dates the funding-fetch behavior + the calibrated band.
 */
export const TRADFI_FUNDING_PROBED_AT = '2026-06-04';

/**
 * Divergence-significance band (8h-equivalent funding spread) above which the
 * cross-venue rates are considered to disagree directionally. MEASURED: p90 of
 * the 30d cross-venue spread distribution over 10 liquid TradFi symbols × 4 CEX
 * venues (902 samples) — see `audits/OPS-TRADFI-XVENUE-FUNDING-W1-funding-matrix.md`.
 * // TODO: revisit by 2026-06-18 (re-pull once more venues accrue ≥30d + HL xyz history wired)
 */
export const TRADFI_DIVERGENCE_BAND_8H = 0.001; // 10 bps / 8h

/** The 5 promoted venues — v1 aggregates these only (shadow venues out of scope). */
const PROMOTED_VENUES: ReadonlyArray<ExchangeId> = ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET'];

/**
 * Per-venue funding settlement interval (minutes). HL pays hourly (1/8 of the
 * computed 8h rate); the 4 CEX settle every 8h for TradFi perps (live-verified
 * 2026-06-04). Bybit is per-symbol via instruments-info but is 480 for every
 * probed TradFi symbol today (documented caveat — read live in a future refinement).
 */
const VENUE_INTERVAL_MINUTES: Record<string, number> = {
  HL: 60, BINANCE: 480, BYBIT: 480, OKX: 480, BITGET: 480,
};

export interface VenueFunding {
  venue: ExchangeId;
  /** Venue-native symbol the rate was read for (e.g. TSLAUSDT / TSLA-USDT-SWAP / xyz:TSLA). */
  venueSymbol: string;
  /** Raw per-period funding rate as returned by the venue. */
  rate: number;
  /** Settlement interval in minutes (HL 60, CEX 480). */
  intervalMinutes: number;
  /** Rate normalized to an 8-hour-equivalent so venues are directly comparable. */
  rate8hEquiv: number;
  /** Unix ms when fetched. */
  fetchedAt: number;
}

/** Normalize a per-period funding rate to its 8h-equivalent (HL 60→×8, CEX 480→×1). */
export function normalizeTo8h(rate: number, intervalMinutes: number): number {
  if (!Number.isFinite(rate) || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return 0;
  return rate * (480 / intervalMinutes);
}

/**
 * Price fingerprint (the semantic-fingerprint LAW, runtime guard): is `price`
 * within `factor`× of the cross-venue `median`? Rejects SPX6900-class symbol
 * misidentification (a venue silently listing a different asset under the same
 * canonical name). Pure + exported for unit testing.
 */
export function priceFingerprintPass(price: number, median: number, factor = 2): boolean {
  if (!(price > 0) || !(median > 0)) return false;
  return price <= factor * median && price >= median / factor;
}

/** Venue-native symbol for a canonical coin (audit/debug label). */
function venueNativeSymbol(coin: string, venue: ExchangeId): string {
  switch (venue) {
    case 'BINANCE': return toBinanceSymbol(coin);
    case 'BYBIT':   return toBybitSymbol(coin);
    case 'BITGET':  return toBitgetSymbol(coin);
    case 'OKX':     return `${coin}-USDT-SWAP`;
    case 'HL':      return `xyz:${coin}`;
    default:        return coin;
  }
}

// ── Module-level TTL cache (cache-seam trio per CLAUDE.md singleton rule) ──
const FUNDING_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
interface FundingCacheEntry { data: VenueFunding[]; fetchedAt: number; }
const fundingByVenueCache = new Map<string, FundingCacheEntry>();

/**
 * Fetch the per-venue funding rates for a TradFi coin across the 5 promoted
 * venues it is listed on. Reuses each adapter's existing `getAssetContext`
 * integration (HL via `dex:"xyz"`) — the generator-level reuse, so new venues /
 * listings inherit for free. Per-venue FAIL-SOFT (a venue error → that venue is
 * omitted, debug-logged); NEVER throws. 10-min TTL cached per coin; fan-out is
 * parallel so wall-clock ≈ the slowest venue, not the sum.
 */
export async function fetchTradFiFundingByVenue(coin: string): Promise<VenueFunding[]> {
  const symbol = coin.toUpperCase();
  const cached = fundingByVenueCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < FUNDING_CACHE_TTL_MS) {
    return cached.data;
  }

  const venues = getVenuesSupporting(symbol).filter((v) => PROMOTED_VENUES.includes(v));
  const settled = await Promise.all(
    venues.map(async (venue): Promise<(VenueFunding & { price: number }) | null> => {
      try {
        const dex: DexType | undefined = venue === 'HL' ? getDexForCoin(symbol) : undefined;
        const ctx = await getAdapter(venue).getAssetContext(symbol, dex);
        const rate = Number.isFinite(ctx.funding) ? ctx.funding : 0;
        const intervalMinutes = VENUE_INTERVAL_MINUTES[venue] ?? 480;
        return {
          venue,
          venueSymbol: venueNativeSymbol(symbol, venue),
          rate,
          intervalMinutes,
          rate8hEquiv: normalizeTo8h(rate, intervalMinutes),
          fetchedAt: Date.now(),
          price: Number.isFinite(ctx.markPx) ? ctx.markPx : (Number.isFinite(ctx.oraclePx) ? ctx.oraclePx : 0),
        };
      } catch (e) {
        console.debug(`[tradfi-funding] ${venue} ${symbol} funding fetch failed (omitted):`, e instanceof Error ? e.message : e);
        return null;
      }
    }),
  );

  const present = settled.filter((x): x is VenueFunding & { price: number } => x !== null);
  // Runtime price-fingerprint guard (SPX6900 LAW): drop any venue whose price is
  // off-magnitude vs the cross-venue median → future symbol-misID protection.
  // BITGET is EXEMPT: its adapter price is known-broken (the /tickers plural
  // endpoint ignores ?symbol= and returns [0]=YGGUSDT — flagged as
  // OPS-BITGET-TICKER-SYMBOL-FILTER-W1); its FUNDING endpoint is symbol-correct,
  // so Bitget funding is trusted and its price is excluded from the fingerprint.
  const refPrices = present.filter(p => p.venue !== 'BITGET' && p.price > 0).map(p => p.price).sort((a, b) => a - b);
  const median = refPrices.length ? refPrices[Math.floor(refPrices.length / 2)] : null;
  const kept = present.filter((p) => {
    if (p.venue === 'BITGET') return true;             // funding trusted; price-fingerprint skipped (adapter bug)
    if (median === null || !(p.price > 0)) return true; // no reference price → cannot fingerprint → keep
    if (priceFingerprintPass(p.price, median)) return true;
    console.debug(`[tradfi-funding] ${p.venue} ${symbol} price ${p.price} failed fingerprint vs median ${median} — dropped`);
    return false;
  });

  const data: VenueFunding[] = kept.map(({ price: _price, ...vf }) => vf);
  fundingByVenueCache.set(symbol, { data, fetchedAt: Date.now() });
  return data;
}

/** Test-only: clear the funding-by-venue cache (full reset). Never call in production. */
export function _clearTradFiFundingCache(): void {
  fundingByVenueCache.clear();
}

/** Test-only read-only inspector: cached coin keys + their entry sizes. */
export function _getTradFiFundingCacheState(): { size: number; coins: string[] } {
  return { size: fundingByVenueCache.size, coins: [...fundingByVenueCache.keys()] };
}

/**
 * Cross-venue funding sentiment for TradFi symbols (pure). Maps the 8h-normalized
 * per-venue rates onto the EXISTING 3-value enum using the R1-calibrated band.
 * Quorum: <2 venues → "Insufficient cross-venue data" verbatim.
 */
export function computeTradFiFundingSentiment(
  coin: string,
  venueFunding: VenueFunding[],
  weekendClosed: boolean,
): { sentiment: CrossVenueFundingSentiment; divergenceNote: string } {
  if (venueFunding.length < 2) {
    return { sentiment: 'NEUTRAL', divergenceNote: 'Insufficient cross-venue data' };
  }
  const rates = venueFunding.map(v => v.rate8hEquiv);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const spread = Math.max(...rates) - Math.min(...rates);
  const divergent = spread > TRADFI_DIVERGENCE_BAND_8H;

  let sentiment: CrossVenueFundingSentiment = 'NEUTRAL';
  if (divergent && mean > 0) sentiment = 'BULLISH_BIAS';      // net longs paying across venues
  else if (divergent && mean < 0) sentiment = 'BEARISH_BIAS'; // net shorts paying across venues

  const pct = (r: number) => `${r > 0 ? '+' : ''}${(r * 100).toFixed(4)}%`;
  const perVenue = venueFunding.map(v => `${v.venue} ${pct(v.rate8hEquiv)}`).join(' / ');
  const verdict = divergent
    ? `divergent (spread ${(spread * 100).toFixed(4)}% > ${(TRADFI_DIVERGENCE_BAND_8H * 100).toFixed(4)}% band) → net ${mean >= 0 ? 'positive' : 'negative'} funding`
    : 'divergence within normal band';
  const weekendSuffix = weekendClosed ? ' (weekend funding premium is structural on frozen-index venues)' : '';
  return { sentiment, divergenceNote: `${coin} 8h-funding: ${perVenue} — ${verdict}${weekendSuffix}` };
}

/** Build the additive `funding_by_venue` map from per-venue TradFi funding (R4). */
export function buildFundingByVenue(
  venueFunding: VenueFunding[],
): Record<string, { rate: number; interval_min: number; rate_8h_equiv: number }> | undefined {
  if (venueFunding.length === 0) return undefined;
  const out: Record<string, { rate: number; interval_min: number; rate_8h_equiv: number }> = {};
  for (const v of venueFunding) {
    out[v.venue] = { rate: v.rate, interval_min: v.intervalMinutes, rate_8h_equiv: v.rate8hEquiv };
  }
  return out;
}
