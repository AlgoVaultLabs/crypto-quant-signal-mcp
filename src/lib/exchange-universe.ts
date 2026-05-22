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

export interface ExchangeAsset {
  /** Bare coin symbol, uppercase (e.g. `BTC`, `SOL`). */
  coin: string;
  /** USD-notional 24h open interest. Computed `oi × markPx` per exchange's native fields. */
  notionalOI_usd: number;
  /** USD-equivalent 24h trading volume. Computed per-exchange — see per-branch comments. */
  volume24h_usd: number;
}

type PromotedExchangeId = 'HL' | 'BINANCE' | 'BYBIT' | 'OKX' | 'BITGET';

const TIMEOUT_MS = 5000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** HL: `metaAndAssetCtxs` returns OI + markPx + dayNtlVlm. `dayNtlVlm` is natively USD-notional. */
async function fetchHL(limit: number): Promise<ExchangeAsset[]> {
  const res = await fetchWithTimeout('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  const raw = (await res.json()) as [
    { universe: { name: string }[] },
    { openInterest?: string; markPx?: string; dayNtlVlm?: string }[],
  ];
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
  const res = await fetchWithTimeout('https://api.bybit.com/v5/market/tickers?category=linear');
  const json = (await res.json()) as {
    result: { list: Array<{ symbol: string; openInterest?: string; lastPrice?: string; turnover24h?: string }> };
  };
  const assets: ExchangeAsset[] = json.result.list
    .filter((t) => t.symbol.endsWith('USDT'))
    .map((t) => {
      const oi = parseFloat(t.openInterest || '0');
      const px = parseFloat(t.lastPrice || '0');
      return {
        coin: t.symbol.replace(/USDT$/, '').toUpperCase(),
        notionalOI_usd: oi * px,
        volume24h_usd: parseFloat(t.turnover24h || '0'), // turnover24h is USDT-denominated
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
  const [oiRes, tickersRes] = await Promise.all([
    fetchWithTimeout('https://www.okx.com/api/v5/public/open-interest?instType=SWAP'),
    fetchWithTimeout('https://www.okx.com/api/v5/market/tickers?instType=SWAP'),
  ]);
  const oiData = (await oiRes.json()) as { data: Array<{ instId: string; oiCcy?: string }> };
  const tickersData = (await tickersRes.json()) as {
    data: Array<{ instId: string; last?: string; markPx?: string; volCcy24h?: string }>;
  };
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
  const res = await fetchWithTimeout('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');
  const json = (await res.json()) as {
    data: Array<{ symbol: string; holdingAmount?: string; markPrice?: string; quoteVolume?: string }>;
  };
  const assets: ExchangeAsset[] = json.data
    .filter((t) => t.symbol.endsWith('USDT'))
    .map((t) => {
      const oi = parseFloat(t.holdingAmount || '0');
      const px = parseFloat(t.markPrice || '0');
      return {
        coin: t.symbol.replace(/USDT$/, '').toUpperCase(),
        notionalOI_usd: oi * px,
        volume24h_usd: parseFloat(t.quoteVolume || '0'), // quoteVolume is USDT-denominated
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
