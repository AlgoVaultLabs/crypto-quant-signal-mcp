/**
 * structural-sources.ts — OPS-STRUCTURAL-FEATURE-ACCRUAL-W1
 *
 * The GAP-CLOSING HTTP layer for the structural feature stream (mark · index · bid · ask).
 * Deliberately thin: `exchange-universe.ts` already reads every structural field its venue's
 * bulk payload happens to carry (zero extra calls); this module issues ONE targeted bulk call
 * per remaining field per venue and returns a coin→patch map the sampler merges on top.
 *
 * Live census 2026-07-21 (audits/OPS-STRUCTURAL-FEATURE-ACCRUAL-W1-endpoint-truth.md §2) —
 * `curl <bulk endpoint> | jq keys` on every promoted venue, host-side from 204:
 *
 *   FREE (all four inline, 0 calls here):  HL · BYBIT · BITGET · GATE · MEXC
 *   GAPS closed below (10 calls total/hr):
 *     BINANCE  +2  premiumIndex (mark+index)      · ticker/bookTicker (bid+ask)
 *     ASTER    +2  premiumIndex                   · ticker/bookTicker   (Binance-compatible fork)
 *     OKX      +2  public/mark-price              · market/index-tickers
 *     KUCOIN   +1  v1/allTickers                  (bestBid/AskPrice)
 *     PHEMEX   +1  md/v3/ticker/24hr/all          (bidRp/askRp — v3 carries the book, v2 does not)
 *     HTX      +1  linear-swap-api/v1/swap_index  (index only)
 *     BINGX    +1  swap/v2/quote/premiumIndex     (mark+index)
 *
 * HTX exposes NO bulk mark-price endpoint (probed: `swap_batch_merged` 404s, `batch_merged`
 * carries no mark field) ⇒ HTX `mark_price` is permanently NULL and is COUNTED as such in the
 * coverage report. Never substituted from `close` — a last-trade price is not a mark price.
 *
 * Every call routes through `upstreamFetch` so it inherits the venue's cross-process weight
 * budget, typed 418/429 ban handling (never retried), and per-venue timeout. `cls: 'batch'`
 * keeps this hourly cron in the batch lane, out of the interactive reserve.
 *
 * Fail-soft is the CALLER's job per venue (the sampler already try/catches per venue); a single
 * failing gap call inside one venue degrades that venue's patch to `{}` rather than throwing,
 * so a bookTicker outage never costs us the mark/index we did retrieve.
 */

import type { ExchangeId } from '../types.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS, type VenueFetchConfig } from './adapters/_upstream-fetch.js';
import { normalizeBinanceCoin } from './coin-overrides.js';

/** The four structural fields. All optional — absent ⇔ the venue does not expose it. */
export interface StructuralPatch {
  markPx?: number;
  indexPx?: number;
  bidPx?: number;
  askPx?: number;
}

/** Coerce → strictly-positive finite number, else undefined ("absent", never 0). */
function pos(x: unknown): number | undefined {
  const n = typeof x === 'number' ? x : parseFloat(String(x ?? ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Merge `patch` into `map[coin]`, keeping already-present values (first writer wins per field). */
function mergeInto(map: Map<string, StructuralPatch>, coin: string, patch: StructuralPatch): void {
  if (!coin) return;
  const cur = map.get(coin) ?? {};
  map.set(coin, {
    markPx: cur.markPx ?? patch.markPx,
    indexPx: cur.indexPx ?? patch.indexPx,
    bidPx: cur.bidPx ?? patch.bidPx,
    askPx: cur.askPx ?? patch.askPx,
  });
}

/** Run a gap call, downgrading ANY failure to "no patch" — never lose the fields that DID land. */
async function soft(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[structural] ${label} gap call failed (soft):`, err instanceof Error ? err.message : err);
  }
}

// ── Binance-family (Binance + its Aster fork share the fapi shape verbatim) ──
interface BinanceLikeHosts { premium: string; book: string }
const BINANCE_HOSTS: BinanceLikeHosts = {
  premium: 'https://fapi.binance.com/fapi/v1/premiumIndex',
  book: 'https://fapi.binance.com/fapi/v1/ticker/bookTicker',
};
const ASTER_HOSTS: BinanceLikeHosts = {
  premium: 'https://fapi.asterdex.com/fapi/v1/premiumIndex',
  book: 'https://fapi.asterdex.com/fapi/v1/ticker/bookTicker',
};

async function fetchBinanceLike(
  cfg: VenueFetchConfig,
  hosts: BinanceLikeHosts,
  /** Aster is a Binance fork → the same 1000×-meme coin overrides apply (1000PEPE → PEPE). */
  normalizeCoin: (c: string) => string,
): Promise<Map<string, StructuralPatch>> {
  const out = new Map<string, StructuralPatch>();
  const coinOf = (symbol: string): string => normalizeCoin(symbol.replace(/USDT$/, '').toUpperCase());
  await soft('premiumIndex', async () => {
    const rows = await upstreamFetch<Array<{ symbol?: string; markPrice?: string; indexPrice?: string }>>(
      cfg, { url: hosts.premium, method: 'GET', cls: 'batch' });
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r.symbol?.endsWith('USDT')) continue;
      mergeInto(out, coinOf(r.symbol), { markPx: pos(r.markPrice), indexPx: pos(r.indexPrice) });
    }
  });
  await soft('bookTicker', async () => {
    const rows = await upstreamFetch<Array<{ symbol?: string; bidPrice?: string; askPrice?: string }>>(
      cfg, { url: hosts.book, method: 'GET', cls: 'batch' });
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r.symbol?.endsWith('USDT')) continue;
      mergeInto(out, coinOf(r.symbol), { bidPx: pos(r.bidPrice), askPx: pos(r.askPrice) });
    }
  });
  return out;
}

/** OKX: mark + index are two SEPARATE bulk endpoints — `market/tickers` carries neither. */
async function fetchOkxGaps(): Promise<Map<string, StructuralPatch>> {
  const out = new Map<string, StructuralPatch>();
  await soft('okx mark-price', async () => {
    const json = await upstreamFetch<{ data?: Array<{ instId?: string; markPx?: string }> }>(
      VENUE_FETCH_CONFIGS.OKX,
      { url: 'https://www.okx.com/api/v5/public/mark-price?instType=SWAP', method: 'GET', cls: 'batch' });
    for (const r of json.data ?? []) {
      if (!r.instId?.endsWith('-USDT-SWAP')) continue;
      mergeInto(out, r.instId.replace(/-USDT-SWAP$/, '').toUpperCase(), { markPx: pos(r.markPx) });
    }
  });
  await soft('okx index-tickers', async () => {
    // index instIds are spot pairs ("BTC-USDT"), NOT swap instIds — quoteCcy=USDT returns all.
    const json = await upstreamFetch<{ data?: Array<{ instId?: string; idxPx?: string }> }>(
      VENUE_FETCH_CONFIGS.OKX,
      { url: 'https://www.okx.com/api/v5/market/index-tickers?quoteCcy=USDT', method: 'GET', cls: 'batch' });
    for (const r of json.data ?? []) {
      if (!r.instId?.endsWith('-USDT')) continue;
      mergeInto(out, r.instId.replace(/-USDT$/, '').toUpperCase(), { indexPx: pos(r.idxPx) });
    }
  });
  return out;
}

/** KuCoin: `allTickers` symbols are "<COIN>USDTM" (XBTUSDTM → BTC), unlike contracts/active's baseCurrency. */
async function fetchKucoinGaps(): Promise<Map<string, StructuralPatch>> {
  const out = new Map<string, StructuralPatch>();
  await soft('kucoin allTickers', async () => {
    const json = await upstreamFetch<{ data?: Array<{ symbol?: string; bestBidPrice?: string; bestAskPrice?: string }> }>(
      VENUE_FETCH_CONFIGS.KUCOIN,
      { url: 'https://api-futures.kucoin.com/api/v1/allTickers', method: 'GET', cls: 'batch' });
    for (const r of json.data ?? []) {
      if (!r.symbol?.endsWith('USDTM')) continue;
      const base = r.symbol.replace(/USDTM$/, '').toUpperCase();
      mergeInto(out, base === 'XBT' ? 'BTC' : base, { bidPx: pos(r.bestBidPrice), askPx: pos(r.bestAskPrice) });
    }
  });
  return out;
}

/** Phemex: v3 ticker carries the book (bidRp/askRp) that the universe's v2 call lacks. */
async function fetchPhemexGaps(): Promise<Map<string, StructuralPatch>> {
  const out = new Map<string, StructuralPatch>();
  await soft('phemex v3 ticker', async () => {
    const json = await upstreamFetch<{ result?: Array<{ symbol?: string; bidRp?: string; askRp?: string }> }>(
      VENUE_FETCH_CONFIGS.PHEMEX,
      { url: 'https://api.phemex.com/md/v3/ticker/24hr/all', method: 'GET', cls: 'batch' });
    for (const r of json.result ?? []) {
      if (!r.symbol?.endsWith('USDT')) continue;
      mergeInto(out, r.symbol.replace(/USDT$/, '').toUpperCase(), { bidPx: pos(r.bidRp), askPx: pos(r.askRp) });
    }
  });
  return out;
}

/** HTX: bulk index only. No bulk mark endpoint exists ⇒ mark_price NULL, counted (never `close`). */
async function fetchHtxGaps(): Promise<Map<string, StructuralPatch>> {
  const out = new Map<string, StructuralPatch>();
  await soft('htx swap_index', async () => {
    const json = await upstreamFetch<{ data?: Array<{ contract_code?: string; index_price?: number | string }> }>(
      VENUE_FETCH_CONFIGS.HTX,
      { url: 'https://api.hbdm.com/linear-swap-api/v1/swap_index', method: 'GET', cls: 'batch' });
    for (const r of json.data ?? []) {
      if (!r.contract_code?.endsWith('-USDT')) continue;
      mergeInto(out, r.contract_code.replace(/-USDT$/, '').toUpperCase(), { indexPx: pos(r.index_price) });
    }
  });
  return out;
}

/** BingX: premiumIndex carries mark+index; the book is already inline on the universe call. */
async function fetchBingxGaps(): Promise<Map<string, StructuralPatch>> {
  const out = new Map<string, StructuralPatch>();
  await soft('bingx premiumIndex', async () => {
    const json = await upstreamFetch<{ data?: Array<{ symbol?: string; markPrice?: string; indexPrice?: string }> }>(
      VENUE_FETCH_CONFIGS.BINGX,
      { url: 'https://open-api.bingx.com/openApi/swap/v2/quote/premiumIndex', method: 'GET', cls: 'batch' });
    for (const r of json.data ?? []) {
      if (!r.symbol?.endsWith('-USDT')) continue;
      mergeInto(out, r.symbol.replace(/-USDT$/, '').toUpperCase(), { markPx: pos(r.markPrice), indexPx: pos(r.indexPrice) });
    }
  });
  return out;
}

/**
 * Venues whose structural fields are FULLY inline on the universe call — no gap call needed.
 * Exported so the coverage report can assert "0 extra calls" rather than infer it.
 */
export const STRUCTURAL_INLINE_VENUES: ReadonlySet<ExchangeId> =
  new Set<ExchangeId>(['HL', 'BYBIT', 'BITGET', 'GATE', 'MEXC']);

/**
 * Per-venue coin→structural patch for the fields the venue's universe payload does NOT carry.
 * Returns an EMPTY map for the 5 inline venues and for any venue with no gap fetcher — the
 * caller merges patches on top of the universe values, so an empty map is a correct no-op.
 */
export async function fetchStructuralGaps(exchange: ExchangeId): Promise<Map<string, StructuralPatch>> {
  switch (exchange) {
    case 'BINANCE':
      return fetchBinanceLike(VENUE_FETCH_CONFIGS.BINANCE, BINANCE_HOSTS, normalizeBinanceCoin);
    case 'ASTER':
      return fetchBinanceLike(VENUE_FETCH_CONFIGS.ASTER, ASTER_HOSTS, normalizeBinanceCoin);
    case 'OKX':
      return fetchOkxGaps();
    case 'KUCOIN':
      return fetchKucoinGaps();
    case 'PHEMEX':
      return fetchPhemexGaps();
    case 'HTX':
      return fetchHtxGaps();
    case 'BINGX':
      return fetchBingxGaps();
    default:
      return new Map();
  }
}
