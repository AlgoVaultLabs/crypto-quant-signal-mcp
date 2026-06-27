/**
 * Exchange Universe — fetches top-N USDT-margined perps per exchange by
 * notional open interest, plus each asset's 24h USD-equivalent volume.
 *
 * Consumer: per-exchange meme-liquidity gate in `src/lib/asset-tiers.ts`
 * (`isMemeCoinLiquid` per-exchange-AND semantics). See OPS-3M-EXPAND-W1
 * audit at `audits/OPS-3M-EXPAND-W1-endpoint-truth.md` for the Q-resolutions
 * informing per-exchange semantic decisions (esp. Q-OKX-VOL-DENOMINATION).
 *
 * Why this is separate from `oi-ranking.ts`: oi-ranking is purposefully
 * HL-only (HIP-3 xyz handling, dual-dex semantics). This module handles
 * the 5 PROMOTED venues uniformly with per-exchange branches and a single
 * canonical return shape.
 *
 * Only supports the 5 PROMOTED venues. Shadow venues short-circuit at
 * the gate level (asset-tiers.ts SHADOW_VENUE_PERMISSIVE_PASS branch).
 */

import type { ExchangeId } from '../types.js';
import { getTicker24hrFullCoalesced } from './adapters/binance.js';
import { hlInfoPost } from './adapters/hyperliquid.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS } from './adapters/_upstream-fetch.js';

export interface ExchangeAsset {
  /** Bare coin symbol, uppercase (e.g. `BTC`, `SOL`). */
  coin: string;
  /** USD-notional 24h open interest. Computed `oi × markPx` per exchange's native fields. */
  notionalOI_usd: number;
  /** USD-equivalent 24h trading volume. Computed per-exchange — see per-branch comments. */
  volume24h_usd: number;
  // ── SCAN-RANKBY-W1: additive rank-metric fields (back-compat — `oi`/`volume`
  //    consumers like asset-tiers.ts ignore these). Per-venue divergence is LAW:
  //    24h-% is reconstructed UNIFORMLY as `(last − prior) / prior × 100` from each
  //    venue's OWN prior-price field (Binance `openPrice` / Bybit `prevPrice24h` /
  //    OKX·Bitget `open24h` / HL `prevDayPx`) — never assume a shared %-field or scale. ──
  /** Signed 24h price change PERCENT (e.g. +5.2 = +5.2%). undefined if unavailable. */
  changePct24h?: number;
  /** Per-interval funding rate as a FRACTION (e.g. 0.0001 = 0.01%). undefined when the
   *  venue's bulk call omits funding (Binance/OKX — filled by rank-metrics.ts). */
  fundingRate?: number;
  /** Funding interval in hours (HL=1; Bybit live `fundingIntervalHour`; 8h default
   *  elsewhere). null = unknown → APR null (never guessed). */
  fundingIntervalHours?: number | null;
}

type PromotedExchangeId = 'HL' | 'BINANCE' | 'BYBIT' | 'OKX' | 'BITGET';

/** Default funding interval (hours) for venues that don't report it on the bulk call. */
const DEFAULT_FUNDING_INTERVAL_H = 8;
/** Hyperliquid funding is HOURLY — NOT 8h (verified live 2026-06-27; APR ×8760). */
const HL_FUNDING_INTERVAL_H = 1;

/** Uniform signed 24h % from a venue's last + prior-day price. undefined when unusable. */
function pctChange24h(last: number, prior: number): number | undefined {
  if (Number.isFinite(last) && Number.isFinite(prior) && prior > 0) {
    return ((last - prior) / prior) * 100;
  }
  return undefined;
}

/** Parse a funding fraction string → number, or undefined when absent/unparseable. */
function parseFunding(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
}

// OPS-ADAPTER-RATELIMIT-UNIFY-W1 (C1/C4): the former local `fetchWithTimeout`
// helper + its TIMEOUT_MS were removed — all five fetchers now route through the
// shared `upstreamFetch` (Bybit/OKX/Bitget) or the adapter coalescers (HL/Binance),
// each carrying its own per-venue timeout from VENUE_FETCH_CONFIGS.

/** HL: `metaAndAssetCtxs` returns OI + markPx + dayNtlVlm. `dayNtlVlm` is natively USD-notional. */
async function fetchHL(limit: number): Promise<ExchangeAsset[]> {
  // OPS-HL-RATELIMITER-W2: route through the shared HL weight budget (was a
  // direct fetch bypassing the adapter chokepoint).
  const raw = await hlInfoPost<[
    { universe: { name: string }[] },
    { openInterest?: string; markPx?: string; dayNtlVlm?: string; prevDayPx?: string; funding?: string }[],
  ]>({ type: 'metaAndAssetCtxs' });
  const meta = raw[0];
  const ctxs = raw[1];
  const assets: ExchangeAsset[] = meta.universe
    .map((a, i) => {
      const oi = parseFloat(ctxs[i]?.openInterest || '0');
      const px = parseFloat(ctxs[i]?.markPx || '0');
      const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
      return {
        coin: a.name.toUpperCase(),
        notionalOI_usd: oi * px,
        volume24h_usd: vol, // HL natively reports USD-notional volume
        // SCAN-RANKBY-W1: % from prevDayPx; funding is HOURLY (interval = 1h).
        changePct24h: pctChange24h(px, parseFloat(ctxs[i]?.prevDayPx || '0')),
        fundingRate: parseFunding(ctxs[i]?.funding),
        fundingIntervalHours: HL_FUNDING_INTERVAL_H,
      };
    })
    .filter((a) => a.notionalOI_usd > 0);
  assets.sort((a, b) => b.notionalOI_usd - a.notionalOI_usd);
  return assets.slice(0, limit);
}

/**
 * Binance: `fapi/v1/ticker/24hr` returns `quoteVolume` (USDT-denominated for USDT-margined perps).
 * No bulk OI endpoint exists; use `quoteVolume` as the OI-rank proxy (matches existing
 * `fetchBinanceCoins` precedent in seed-signals.ts).
 *
 * OPS-BINANCE-POLITE-DELAY-W1 (2026-05-22): served from adapter's coalesced
 * full-universe ticker/24hr cache (60s TTL). Eliminates the previous duplicate
 * full-universe fetch (40 weight) when `isMemeCoinLiquid` cache cold-starts
 * within the same fire window that `fetchBinanceCoins` (seed loop) is using.
 */
async function fetchBinance(limit: number): Promise<ExchangeAsset[]> {
  const data = await getTicker24hrFullCoalesced();
  const assets: ExchangeAsset[] = data
    .filter((t) => t.symbol.endsWith('USDT'))
    .map((t) => {
      const qv = parseFloat(t.quoteVolume || '0');
      return {
        coin: t.symbol.replace(/USDT$/, '').toUpperCase(),
        notionalOI_usd: qv, // proxy: rank by 24h USD volume since no bulk OI endpoint
        volume24h_usd: qv, // quoteVolume is USDT-denominated (≈ USD for USDT-margined perps)
        // SCAN-RANKBY-W1: % from openPrice (futures 24h-open; prevClosePrice is spot-only —
        // OPS-TRADE-CALL-CLUSTER-W1). Funding is NOT on ticker/24hr → filled by rank-metrics.ts
        // from the bulk premiumIndex; interval default 8h.
        changePct24h: pctChange24h(parseFloat(t.lastPrice || '0'), parseFloat(t.openPrice || '0')),
        fundingIntervalHours: DEFAULT_FUNDING_INTERVAL_H,
      };
    });
  assets.sort((a, b) => b.notionalOI_usd - a.notionalOI_usd);
  return assets.slice(0, limit);
}

/**
 * Bybit: `v5/market/tickers?category=linear` returns `openInterest` + `lastPrice` + `turnover24h`.
 * `turnover24h` is USDT-denominated. notionalOI_usd = openInterest × lastPrice.
 */
async function fetchBybit(limit: number): Promise<ExchangeAsset[]> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: routed through the shared upstreamFetch so this
  // non-adapter Bybit caller inherits the cross-process budget + typed 403/ban handling.
  const json = await upstreamFetch<{
    result: { list: Array<{ symbol: string; openInterest?: string; lastPrice?: string; turnover24h?: string;
      prevPrice24h?: string; fundingRate?: string; fundingIntervalHour?: number | string }> };
  }>(VENUE_FETCH_CONFIGS.BYBIT, { url: 'https://api.bybit.com/v5/market/tickers?category=linear' });
  const assets: ExchangeAsset[] = json.result.list
    .filter((t) => t.symbol.endsWith('USDT'))
    .map((t) => {
      const oi = parseFloat(t.openInterest || '0');
      const px = parseFloat(t.lastPrice || '0');
      // SCAN-RANKBY-W1: % from prevPrice24h; funding + interval BOTH live in the tickers call.
      const interval = t.fundingIntervalHour != null ? Number(t.fundingIntervalHour) : NaN;
      return {
        coin: t.symbol.replace(/USDT$/, '').toUpperCase(),
        notionalOI_usd: oi * px,
        volume24h_usd: parseFloat(t.turnover24h || '0'), // turnover24h is USDT-denominated
        changePct24h: pctChange24h(px, parseFloat(t.prevPrice24h || '0')),
        fundingRate: parseFunding(t.fundingRate),
        fundingIntervalHours: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_FUNDING_INTERVAL_H,
      };
    });
  assets.sort((a, b) => b.notionalOI_usd - a.notionalOI_usd);
  return assets.slice(0, limit);
}

/**
 * OKX: two endpoints — `public/open-interest?instType=SWAP` for OI (in base ccy via `oiCcy`),
 * `market/tickers?instType=SWAP` for `volCcy24h` + `markPx`.
 *
 * **Q-OKX-VOL-DENOMINATION resolution** (audits/OPS-3M-EXPAND-W1-endpoint-truth.md §B row 12):
 * `volCcy24h` is BASE-currency-denominated (BTC for BTC-USDT-SWAP). USD-equivalent =
 * `volCcy24h × markPx`. Confirmed via live probe — for BTC-USDT-SWAP, `volCcy24h` ≈ 73,379 BTC ×
 * ~$77,394 ≈ $5.68B USD (matches expected daily BTC perp volume magnitude).
 */
async function fetchOKX(limit: number): Promise<ExchangeAsset[]> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: routed through upstreamFetch (budget + typed ban).
  const [oiData, tickersData] = await Promise.all([
    upstreamFetch<{ data: Array<{ instId: string; oiCcy?: string }> }>(
      VENUE_FETCH_CONFIGS.OKX, { url: 'https://www.okx.com/api/v5/public/open-interest?instType=SWAP' }),
    upstreamFetch<{ data: Array<{ instId: string; last?: string; markPx?: string; volCcy24h?: string; open24h?: string }> }>(
      VENUE_FETCH_CONFIGS.OKX, { url: 'https://www.okx.com/api/v5/market/tickers?instType=SWAP' }),
  ]);
  const tickerMap = new Map(tickersData.data.map((t) => [t.instId, t]));
  const assets: ExchangeAsset[] = oiData.data
    .filter((o) => o.instId.endsWith('-USDT-SWAP'))
    .map((o) => {
      const ticker = tickerMap.get(o.instId);
      const px = parseFloat(ticker?.markPx || ticker?.last || '0');
      const volBase = parseFloat(ticker?.volCcy24h || '0');
      const oiBase = parseFloat(o.oiCcy || '0');
      return {
        coin: o.instId.replace(/-USDT-SWAP$/, '').toUpperCase(),
        notionalOI_usd: oiBase * px,
        volume24h_usd: volBase * px, // Q-OKX-VOL-DENOMINATION: volCcy24h is base-denominated; multiply by markPx
        // SCAN-RANKBY-W1: % from open24h. OKX has NO bulk funding endpoint (live 50014) →
        // funding filled by rank-metrics.ts per-instId over the bounded pool; interval default 8h.
        changePct24h: pctChange24h(px, parseFloat(ticker?.open24h || '0')),
        fundingIntervalHours: DEFAULT_FUNDING_INTERVAL_H,
      };
    });
  assets.sort((a, b) => b.notionalOI_usd - a.notionalOI_usd);
  return assets.slice(0, limit);
}

/**
 * Bitget: `v2/mix/market/tickers?productType=USDT-FUTURES` returns `holdingAmount` (OI in base),
 * `markPrice`, and `quoteVolume` (USDT-denominated; verified via probe matching `usdtVolume` byte-for-byte).
 */
async function fetchBitget(limit: number): Promise<ExchangeAsset[]> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: routed through upstreamFetch (budget + typed ban/body-code).
  const json = await upstreamFetch<{
    data: Array<{ symbol: string; holdingAmount?: string; markPrice?: string; quoteVolume?: string;
      open24h?: string; lastPr?: string; fundingRate?: string }>;
  }>(VENUE_FETCH_CONFIGS.BITGET, { url: 'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES' });
  const assets: ExchangeAsset[] = json.data
    .filter((t) => t.symbol.endsWith('USDT'))
    .map((t) => {
      const oi = parseFloat(t.holdingAmount || '0');
      const px = parseFloat(t.markPrice || '0');
      // SCAN-RANKBY-W1: % from open24h (last = lastPr, fallback markPrice); funding in the same call.
      const last = parseFloat(t.lastPr || t.markPrice || '0');
      return {
        coin: t.symbol.replace(/USDT$/, '').toUpperCase(),
        notionalOI_usd: oi * px,
        volume24h_usd: parseFloat(t.quoteVolume || '0'), // quoteVolume is USDT-denominated
        changePct24h: pctChange24h(last, parseFloat(t.open24h || '0')),
        fundingRate: parseFunding(t.fundingRate),
        fundingIntervalHours: DEFAULT_FUNDING_INTERVAL_H,
      };
    });
  assets.sort((a, b) => b.notionalOI_usd - a.notionalOI_usd);
  return assets.slice(0, limit);
}

const FETCHERS: Record<PromotedExchangeId, (limit: number) => Promise<ExchangeAsset[]>> = {
  HL: fetchHL,
  BINANCE: fetchBinance,
  BYBIT: fetchBybit,
  OKX: fetchOKX,
  BITGET: fetchBitget,
};

/**
 * Fetch top-N USDT-margined perps on `exchange` by notional OI, returning
 * each asset's coin symbol + USD-notional OI + 24h USD-equivalent volume.
 *
 * Sorted descending by `notionalOI_usd`. Returns at most `limit` entries.
 *
 * Only supports the 5 PROMOTED venues (HL, BINANCE, BYBIT, OKX, BITGET).
 * Shadow venues are intentionally not supported here — `isMemeCoinLiquid`
 * short-circuits TRUE for them at a higher level (per OPS-3M-EXPAND-W1
 * Q3 resolution `SHADOW_VENUE_PERMISSIVE_PASS`).
 *
 * Throws if invoked with a shadow venue or unknown ExchangeId — callers
 * must filter beforehand.
 */
export async function getExchangeTopAssetsWithVolume(
  exchange: ExchangeId,
  limit: number,
): Promise<ExchangeAsset[]> {
  const fetcher = FETCHERS[exchange as PromotedExchangeId];
  if (!fetcher) {
    throw new Error(
      `getExchangeTopAssetsWithVolume: unsupported exchange '${exchange}' ` +
        `(expected one of HL/BINANCE/BYBIT/OKX/BITGET)`,
    );
  }
  return fetcher(limit);
}

/**
 * SCAN-RANKBY-W1: the FULL rich USDT-perp universe on `exchange` (OI-desc, NO
 * slice), each asset carrying the rank-metric fields. The seam `getRankedUniverse`
 * (rank-metrics.ts) generalizes — it re-sorts this set by the chosen lens. Same
 * 5-venue support + throw contract as `getExchangeTopAssetsWithVolume`; the
 * `Number.MAX_SAFE_INTEGER` limit makes each fetcher's `slice` a no-op (return all).
 */
export async function fetchVenueUniverse(exchange: ExchangeId): Promise<ExchangeAsset[]> {
  const fetcher = FETCHERS[exchange as PromotedExchangeId];
  if (!fetcher) {
    throw new Error(
      `fetchVenueUniverse: unsupported exchange '${exchange}' ` +
        `(expected one of HL/BINANCE/BYBIT/OKX/BITGET)`,
    );
  }
  return fetcher(Number.MAX_SAFE_INTEGER);
}
