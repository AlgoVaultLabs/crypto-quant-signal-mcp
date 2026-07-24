/**
 * retro-basis-sources.ts — OPS-BASIS-RETRO-BACKFILL-W1
 *
 * Reconstructs the perp BASIS time series `(mark − index)/index × 1e4` at 1h granularity from each
 * venue's HISTORICAL mark-price kline + index-price kline. The live sampler (oi-snapshot-sampler.ts)
 * derives basis FORWARD from the :17 bulk ticker; this module derives it BACKWARD from klines, so the
 * pre-registered B-DIR v3 diagnostic can bank basis's ≥90d of data instead of waiting to accrue it.
 *
 * Reconstruction set — probed host-side 2026-07-24, every venue verified to serve BOTH mark AND index
 * klines at 1h with real ≥365d depth (OLDEST bar landed at the requested date, not recent-only):
 *     BINANCE · BYBIT · OKX · BITGET · GATE · ASTER · MEXC.
 * Excluded-with-reason (audits/OPS-BASIS-RETRO-BACKFILL-W1-endpoint-truth.md §2): HL (no historical
 * index/oracle kline; candleSnapshot caps ~208d), HTX (no canonical mark+index pair — only a native
 * premium kline, which the single-derivation LAW forbids substituting), PHEMEX (kline throttled from
 * prod egress), KUCOIN (traded-kline only), BINGX (markPriceKlines but NO index kline), and the three
 * newest venues BITMART/WHITEBIT/XT (OI-only or 404 on mark/index klines).
 *
 * Derivation is the SAME `basisBps` the live sampler uses (single-derivation LAW) — this module only
 * SOURCES the mark/index inputs; it never re-implements the formula and never substitutes a venue's
 * native premium/basis field for the computed value.
 *
 * All venue calls route through `upstreamFetch` (shared cross-process weight budget, typed 418/429 —
 * NEVER retried, `cls:'batch'` = out of the interactive reserve). Parsers are PURE + fixture-locked.
 */

import type { ExchangeId } from '../types.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS } from './adapters/_upstream-fetch.js';

const HOUR_MS = 3_600_000;

/** The 7 venues whose mark+index klines were probed to serve deep (≥365d) 1h history. */
export const RECONSTRUCT_VENUES = [
  'BINANCE',
  'BYBIT',
  'OKX',
  'BITGET',
  'GATE',
  'ASTER',
  'MEXC',
] as const;
export type ReconstructVenue = (typeof RECONSTRUCT_VENUES)[number];

export function isReconstructVenue(v: string): v is ReconstructVenue {
  return (RECONSTRUCT_VENUES as readonly string[]).includes(v);
}

/** One normalized hourly bar: hour-floored epoch-ms + the strictly-positive CLOSE price. */
export interface KlineBar {
  ts: number;
  price: number;
}

/** One reconstructed hour: mark + index at the same hour bucket (both strictly-positive). */
export interface AlignedBasis {
  ts: number;
  mark: number;
  index: number;
}

function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function posNum(x: unknown): number | null {
  const n = typeof x === 'number' ? x : parseFloat(String(x ?? ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Push a normalized bar iff ts + price are both valid. */
function pushBar(out: KlineBar[], tsRaw: unknown, priceRaw: unknown, tsUnit: 'ms' | 's'): void {
  const tsn = typeof tsRaw === 'number' ? tsRaw : parseFloat(String(tsRaw ?? ''));
  const price = posNum(priceRaw);
  if (!Number.isFinite(tsn) || price === null) return;
  out.push({ ts: floorHour(tsUnit === 's' ? tsn * 1000 : tsn), price });
}

/**
 * PURE — parse a venue's raw mark/index kline payload into ascending {ts, price} bars.
 * `price` is always the CLOSE of the hourly bar. Invalid/non-positive rows are dropped (counted as
 * absent, never guessed). Ascending, hour-floored, deduped (last write per bucket wins).
 */
export function parseKlines(venue: ReconstructVenue, json: unknown): KlineBar[] {
  const out: KlineBar[] = [];
  switch (venue) {
    case 'BINANCE':
    case 'ASTER': {
      // [[openTime_ms, open, high, low, close, ...], ...] ASC — close at [4]
      for (const r of Array.isArray(json) ? json : []) {
        if (Array.isArray(r)) pushBar(out, r[0], r[4], 'ms');
      }
      break;
    }
    case 'OKX':
    case 'BITGET': {
      // { data: [[ts_ms, o, h, l, c, ...], ...] } — close at [4] (OKX DESC, Bitget ASC; sorted below)
      const data = (json as { data?: unknown[] })?.data;
      for (const r of Array.isArray(data) ? data : []) {
        if (Array.isArray(r)) pushBar(out, r[0], r[4], 'ms');
      }
      break;
    }
    case 'BYBIT': {
      // { result: { list: [[start_ms, o, h, l, c], ...] } } DESC — close at [4]
      const list = (json as { result?: { list?: unknown[] } })?.result?.list;
      for (const r of Array.isArray(list) ? list : []) {
        if (Array.isArray(r)) pushBar(out, r[0], r[4], 'ms');
      }
      break;
    }
    case 'GATE': {
      // [{ t: sec, c: close, ... }, ...] ASC
      for (const r of Array.isArray(json) ? json : []) {
        if (r && typeof r === 'object') pushBar(out, (r as { t?: unknown }).t, (r as { c?: unknown }).c, 's');
      }
      break;
    }
    case 'MEXC': {
      // { data: { time: [sec], close: [num], ... } } columnar ASC
      const d = (json as { data?: { time?: unknown[]; close?: unknown[] } })?.data;
      const time = Array.isArray(d?.time) ? d!.time : [];
      const close = Array.isArray(d?.close) ? d!.close : [];
      for (let i = 0; i < time.length; i++) pushBar(out, time[i], close[i], 's');
      break;
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  // dedup by bucket (last wins) — defends against an overlapping page boundary
  const byTs = new Map<number, number>();
  for (const b of out) byTs.set(b.ts, b.price);
  return [...byTs.entries()].map(([ts, price]) => ({ ts, price })).sort((a, b) => a.ts - b.ts);
}

/**
 * PURE — inner-join mark × index by hour bucket. A basis needs BOTH sides, so a bar present on only
 * one side is dropped (never half-reconstructed). Ascending by ts.
 */
export function alignBasis(mark: KlineBar[], index: KlineBar[]): AlignedBasis[] {
  const idx = new Map(index.map((b) => [b.ts, b.price]));
  const out: AlignedBasis[] = [];
  for (const m of mark) {
    const i = idx.get(m.ts);
    if (i !== undefined && m.price > 0 && i > 0) out.push({ ts: m.ts, mark: m.price, index: i });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export interface VenueKlineSymbols {
  markSym: string;
  indexSym: string;
}

/**
 * PURE — the venue-native mark/index kline symbols for a bare coin.
 * Only BINANCE/ASTER diverge (1000× meme listings, e.g. PEPE → `1000PEPEUSDT`); the caller resolves
 * the real venue symbol from exchangeInfo and passes it as `resolvedVenueSymbol`. The other five are
 * deterministic from the coin.
 */
export function venueKlineSymbols(
  venue: ReconstructVenue,
  coin: string,
  resolvedVenueSymbol?: string,
): VenueKlineSymbols {
  const c = coin.toUpperCase();
  switch (venue) {
    case 'BINANCE':
    case 'ASTER': {
      const sym = resolvedVenueSymbol ?? `${c}USDT`;
      return { markSym: sym, indexSym: sym };
    }
    case 'BYBIT':
    case 'BITGET':
      return { markSym: `${c}USDT`, indexSym: `${c}USDT` };
    case 'OKX':
      return { markSym: `${c}-USDT-SWAP`, indexSym: `${c}-USDT` };
    case 'GATE':
      return { markSym: `mark_${c}_USDT`, indexSym: `index_${c}_USDT` };
    case 'MEXC':
      return { markSym: `${c}_USDT`, indexSym: `${c}_USDT` };
  }
}

export interface RetroFetchPlan {
  /** true ⇔ this (venue, coin) has already been reconstructed back to the floor — skip it. */
  done: boolean;
  fetchStartMs: number;
  fetchEndMs: number;
}

/**
 * PURE — DB-as-checkpoint fetch-range planner (the resumability contract; no separate progress file).
 * `existingMinTs` = the deepest (oldest) retro-basis ts already written for this (venue, coin), or
 * null if none. Each run fills OLDER than what exists, down to `startMs`; ON CONFLICT DO NOTHING makes
 * the boundary overlap a no-op. A deploy/restart just re-runs and skips done coins.
 */
export function planRetroFetch(existingMinTs: number | null, startMs: number, endMs: number): RetroFetchPlan {
  if (existingMinTs !== null && existingMinTs <= startMs) return { done: true, fetchStartMs: 0, fetchEndMs: 0 };
  return { done: false, fetchStartMs: startMs, fetchEndMs: existingMinTs ?? endMs };
}

/**
 * PURE — build a coin → venue-kline-symbol map from a Binance-family `exchangeInfo` payload, so the
 * 1000× meme listings (PEPE → `1000PEPEUSDT`) resolve to the symbol the kline endpoints actually key
 * on. Only live USDT-quoted PERPETUALs; `normalizeCoin` is the same override the universe fetcher uses.
 */
export function buildBinanceLikeSymbolMap(
  exchangeInfo: unknown,
  normalizeCoin: (c: string) => string,
): Map<string, string> {
  const out = new Map<string, string>();
  const symbols = (exchangeInfo as { symbols?: unknown })?.symbols;
  if (!Array.isArray(symbols)) return out;
  for (const s of symbols) {
    const sym = (s as { symbol?: unknown }).symbol;
    const ct = (s as { contractType?: unknown }).contractType;
    if (typeof sym !== 'string' || !sym.endsWith('USDT') || ct !== 'PERPETUAL') continue;
    const coin = normalizeCoin(sym.replace(/USDT$/, '').toUpperCase());
    if (coin) out.set(coin, sym);
  }
  return out;
}

// ── Paged network fetch ────────────────────────────────────────────────────────────────────────
// Every call is `cls:'batch'` (out of the interactive reserve) and inherits the venue's cross-process
// weight budget + typed 418/429 (NEVER retried) from `upstreamFetch`. A per-series page cap is a pure
// runaway backstop; the real stop is "empty page" or "cursor reached startMs". Pagination DIALECT
// diverges by venue (forward by startTime / windowed / backward by after|endTime) — probed 2026-07-24.
const MAX_PAGES = 512;

async function getJson(cfg: (typeof VENUE_FETCH_CONFIGS)[string], url: string): Promise<unknown> {
  return upstreamFetch<unknown>(cfg, { url, method: 'GET', cls: 'batch' });
}

/** Fetch one venue's mark OR index hourly series over [startMs, endMs] (inclusive), clamped + deduped. */
async function fetchSeries(
  venue: ReconstructVenue,
  kind: 'mark' | 'index',
  symbol: string,
  startMs: number,
  endMs: number,
): Promise<KlineBar[]> {
  const cfg = VENUE_FETCH_CONFIGS[venue];
  const all: KlineBar[] = [];
  if (startMs > endMs) return [];

  switch (venue) {
    case 'BINANCE':
    case 'ASTER': {
      // Forward by startTime (deep-history honored); close at [4]. limit 1500.
      const host = venue === 'BINANCE' ? 'https://fapi.binance.com' : 'https://fapi.asterdex.com';
      const q = kind === 'mark' ? `markPriceKlines?symbol=${symbol}` : `indexPriceKlines?pair=${symbol}`;
      let cursor = startMs;
      for (let p = 0; p < MAX_PAGES; p++) {
        const url = `${host}/fapi/v1/${q}&interval=1h&startTime=${cursor}&endTime=${endMs}&limit=1500`;
        const bars = parseKlines(venue, await getJson(cfg, url));
        if (bars.length === 0) break;
        all.push(...bars);
        const last = bars[bars.length - 1].ts;
        if (last + HOUR_MS > endMs || last < cursor) break; // covered / no progress
        cursor = last + HOUR_MS;
      }
      break;
    }
    case 'BYBIT': {
      // Windowed [start,end] (DESC, ≤200/page). Walk forward in 200h windows.
      const path = kind === 'mark' ? 'mark-price-kline' : 'index-price-kline';
      const WIN = 200 * HOUR_MS;
      for (let s = startMs; s <= endMs; s += WIN) {
        const e = Math.min(s + WIN - HOUR_MS, endMs);
        const url = `https://api.bybit.com/v5/market/${path}?category=linear&symbol=${symbol}&interval=60&start=${s}&end=${e}&limit=200`;
        all.push(...parseKlines('BYBIT', await getJson(cfg, url)));
      }
      break;
    }
    case 'OKX': {
      // history-*-candles: `after` = OLDER-than cursor, DESC, ≤100/page. Walk BACKWARD to startMs.
      const path = kind === 'mark' ? 'history-mark-price-candles' : 'history-index-candles';
      let after = endMs + HOUR_MS;
      for (let p = 0; p < MAX_PAGES; p++) {
        const url = `https://www.okx.com/api/v5/market/${path}?instId=${symbol}&bar=1H&after=${after}&limit=100`;
        const bars = parseKlines('OKX', await getJson(cfg, url));
        if (bars.length === 0) break;
        all.push(...bars);
        const oldest = bars[0].ts;
        if (oldest <= startMs || oldest >= after) break;
        after = oldest;
      }
      break;
    }
    case 'BITGET': {
      // history-*-candles: `endTime` cursor, returns bars BEFORE it (ASC, ≤200/page). Walk BACKWARD.
      const path = kind === 'mark' ? 'history-mark-candles' : 'history-index-candles';
      let endTime = endMs + HOUR_MS;
      for (let p = 0; p < MAX_PAGES; p++) {
        const url = `https://api.bitget.com/api/v2/mix/market/${path}?symbol=${symbol}&granularity=1H&productType=usdt-futures&endTime=${endTime}&limit=200`;
        const bars = parseKlines('BITGET', await getJson(cfg, url));
        if (bars.length === 0) break;
        all.push(...bars);
        const oldest = bars[0].ts;
        if (oldest <= startMs || oldest >= endTime) break;
        endTime = oldest;
      }
      break;
    }
    case 'GATE': {
      // `symbol` is already the mark_/index_ contract. from/to in SECONDS, ASC, ≤2000/page.
      const WIN = 1990 * HOUR_MS;
      for (let s = startMs; s <= endMs; s += WIN) {
        const from = Math.floor(s / 1000);
        const to = Math.floor(Math.min(s + WIN - HOUR_MS, endMs) / 1000);
        const url = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${symbol}&interval=1h&from=${from}&to=${to}`;
        all.push(...parseKlines('GATE', await getJson(cfg, url)));
      }
      break;
    }
    case 'MEXC': {
      // fair_price(mark) / index_price(index) columnar kline; start/end SECONDS. Windowed.
      const kindPath = kind === 'mark' ? 'fair_price' : 'index_price';
      const WIN = 500 * HOUR_MS;
      for (let s = startMs; s <= endMs; s += WIN) {
        const st = Math.floor(s / 1000);
        const en = Math.floor(Math.min(s + WIN - HOUR_MS, endMs) / 1000);
        const url = `https://contract.mexc.com/api/v1/contract/kline/${kindPath}/${symbol}?interval=Min60&start=${st}&end=${en}`;
        all.push(...parseKlines('MEXC', await getJson(cfg, url)));
      }
      break;
    }
  }

  const byTs = new Map<number, number>();
  for (const b of all) if (b.ts >= startMs && b.ts <= endMs) byTs.set(b.ts, b.price);
  return [...byTs.entries()].map(([ts, price]) => ({ ts, price })).sort((a, b) => a.ts - b.ts);
}

/**
 * Reconstruct a venue's basis inputs over [startMs, endMs] (inclusive hour buckets): fetch the mark
 * series + the index series, align by hour, and return the rows where BOTH exist. `resolvedVenueSymbol`
 * is the exchangeInfo-resolved Binance/Aster symbol (1000× memes); ignored by the other five venues.
 * The caller applies `basisBps(mark, index)` — this module never computes basis itself.
 */
export async function fetchBasisSeries(
  venue: ReconstructVenue,
  coin: string,
  startMs: number,
  endMs: number,
  resolvedVenueSymbol?: string,
): Promise<AlignedBasis[]> {
  const { markSym, indexSym } = venueKlineSymbols(venue, coin, resolvedVenueSymbol);
  const mark = await fetchSeries(venue, 'mark', markSym, startMs, endMs);
  const index = await fetchSeries(venue, 'index', indexSym, startMs, endMs);
  return alignBasis(mark, index);
}
