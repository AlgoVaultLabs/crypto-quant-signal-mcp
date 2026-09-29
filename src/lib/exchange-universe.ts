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
import type { PromotedVenueId } from './capabilities.js';
import { normalizeBinanceCoin } from './coin-overrides.js';
import {
  ADMISSION_SOURCES, admitRows, formatAdmissionLine, isStatusKind, resolveAdmissionMode,
  type AdmissionMode, type AdmissionRow, type AdmissionSide, type AdmissionTally, type StatusMap,
} from './universe-admission.js';

export interface ExchangeAsset {
  /** Bare coin symbol, uppercase (e.g. `BTC`, `SOL`). */
  coin: string;
  /** USD-notional 24h open interest. Computed `oi × markPx` per exchange's native fields. */
  notionalOI_usd: number;
  /** SCAN-RANKBY-REFINEMENTS-W1 CH3: base-coin-unit open interest (price-independent),
   *  i.e. the native OI BEFORE `× markPx`. undefined when the venue has no real bulk OI
   *  (Binance — `notionalOI_usd` is a volume proxy; its base-contracts come per-symbol via
   *  oi-sources). Captured by the OI sampler into `oi_snapshots.contracts_oi`. */
  baseOI?: number;
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
  /** OPS-SCAN-UNIVERSE-EXPAND-W1: true ⇔ `notionalOI_usd` is a 24h-VOLUME liquidity proxy because
   *  the venue exposes no bulk OI endpoint (Binance / Aster / BingX). The oi_change lens + OI sampler
   *  SKIP proxy assets (never record volume as OI); the default / oi + volume lenses still rank them,
   *  labeled "open interest / liquidity". Honest-labeling contract — never silently mislabeled. */
  oiIsProxy?: boolean;
  // ── OPS-STRUCTURAL-FEATURE-ACCRUAL-W1: structural microstructure fields ──
  //    Read from the SAME bulk payload each fetcher ALREADY pulls — zero extra venue calls.
  //    5 venues (HL/BYBIT/BITGET/GATE/MEXC) carry all four inline; the rest carry some or none
  //    and are closed by `structural-sources.ts` with one targeted bulk call per venue.
  //    `undefined` ⇔ the venue's payload omits it → the snapshot column is NULL, counted.
  //    NEVER substituted from another venue or another field (Factuality > Completeness).
  /** Perp mark price (venue-native: markPx / markPrice / fairPrice / markPriceRp). */
  markPx?: number;
  /** Index / oracle price — the SPOT reference for basis. There is no spot-price path in this
   *  repo (all 17 adapters are perps-only); basis is venue-native index, never a spot lookup. */
  indexPx?: number;
  /** Best bid (top of book). */
  bidPx?: number;
  /** Best ask (top of book). */
  askPx?: number;
}

/** Coerce a venue field → strictly-positive finite number, else undefined ("absent", never 0). */
function pos(x: unknown): number | undefined {
  const n = typeof x === 'number' ? x : parseFloat(String(x ?? ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// OPS-SCAN-UNIVERSE-EXPAND-W1: the promoted-venue union, DERIVED from EXCHANGES (capabilities.ts) —
// the single SoT. Was a hand-maintained 5-literal; now the 12 (and every future promotion) flow from
// EXCHANGES, and the `FETCHERS` Record below is tsc-exhaustive (a new promoted venue won't compile
// without its universe fetcher).
type PromotedExchangeId = PromotedVenueId;

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

// ════════════════════════════════════════════════════════════════════════
// OPS-ALARM-SINGLE-DERIVATION-W1 CH2 — THE ONE ADMISSION STEP. Both universe derivations run
// through it: every scan-SoT fetcher via `finalizeUniverse` (admit → sort → slice), and every
// seed-local fetcher in `seed-signals.ts` via `admitVenueRows`. The declarations and the predicate
// are PURE in `universe-admission.ts`; this block owns only the I/O around them — the status fetch,
// its cache, the mode, and the log line that makes every fetch's exclusions visible.
// ════════════════════════════════════════════════════════════════════════

/** A failed status fetch is retried after this long (negative cache — never a stampede). */
const ADMISSION_STATUS_NEGATIVE_TTL_MS = 60_000;

interface CachedStatus { map: StatusMap | null; state: 'ok' | 'unavailable'; expiresAt: number }
const admissionStatusCache = new Map<ExchangeId, CachedStatus>();
let admissionModeWarned = false;

/** Test seam — clears the status cache and the one-time mode warning. */
export function _resetAdmissionStatusCacheForTest(): void {
  admissionStatusCache.clear();
  admissionModeWarned = false;
}

function admissionMode(): AdmissionMode {
  const { mode, warning } = resolveAdmissionMode(process.env.UNIVERSE_ADMISSION_MODE);
  if (warning && !admissionModeWarned) {
    admissionModeWarned = true;
    console.warn(warning);
  }
  return mode;
}

/**
 * The venue's own status, from its declared source. Inline sources parse the payload the caller
 * already holds (zero extra calls); URL sources are fetched once per declared TTL through the shared
 * `upstreamFetch` (budgeted, typed bans, no transient retry — the next TTL retries). NEVER throws:
 * an unreachable or unparseable status resolves to `null`, which ADMITS every row.
 */
async function venueStatus(
  venue: ExchangeId, inlinePayload: unknown,
): Promise<{ map: StatusMap | null; state: AdmissionTally['status'] }> {
  const decl = ADMISSION_SOURCES[venue];
  if (!isStatusKind(decl)) return { map: null, state: 'not_applicable' };
  if (inlinePayload !== undefined) {
    try {
      return { map: decl.parse(inlinePayload), state: 'inline' };
    } catch (e) {
      console.warn(`[universe-admission] ${venue} status unavailable (inline payload unparseable: ${e instanceof Error ? e.message : e}) — admitting the legacy set`);
      return { map: null, state: 'unavailable' };
    }
  }
  if (decl.url === null) {
    console.warn(`[universe-admission] ${venue} status unavailable (inline source, no payload handed in) — admitting the legacy set`);
    return { map: null, state: 'unavailable' };
  }
  const hit = admissionStatusCache.get(venue);
  if (hit && hit.expiresAt > Date.now()) return { map: hit.map, state: hit.state };
  try {
    const payload = await upstreamFetch<unknown>(
      { ...VENUE_FETCH_CONFIGS[venue], transientRetries: 0 },
      { url: decl.url, weightHint: 1 },
    );
    const map = decl.parse(payload);
    admissionStatusCache.set(venue, { map, state: 'ok', expiresAt: Date.now() + decl.cacheTtlMs });
    return { map, state: 'ok' };
  } catch (e) {
    console.warn(`[universe-admission] ${venue} status unavailable (${e instanceof Error ? e.message : e}) — admitting the legacy set`);
    admissionStatusCache.set(venue, { map: null, state: 'unavailable', expiresAt: Date.now() + ADMISSION_STATUS_NEGATIVE_TTL_MS });
    return { map: null, state: 'unavailable' };
  }
}

/**
 * THE admission step, exported for the seed-local fetchers. Rows carry the VENUE symbol (the status
 * key) plus whatever evidence the caller's payload holds; extra fields ride through untouched.
 * Logs exactly one `[universe-admission]` line per call — a fetch is never silent about what it
 * dropped. Never throws.
 */
export async function admitVenueRows<T extends AdmissionRow>(
  venue: ExchangeId, rows: T[], side: AdmissionSide, opts: { inlineStatusPayload?: unknown } = {},
): Promise<T[]> {
  const mode = admissionMode();
  const decl = ADMISSION_SOURCES[venue];
  const wantsStatus = mode === 'enforce' && isStatusKind(decl) && rows.length > 0;
  const { map, state } = wantsStatus
    ? await venueStatus(venue, opts.inlineStatusPayload)
    : { map: null, state: 'not_applicable' as const };
  const { rows: kept, tally } = admitRows(venue, rows, map, Date.now(), mode, side, state);
  console.log(formatAdmissionLine(tally));
  return kept;
}

/** Venues whose universe payload carries a book inline — only there is `no_book` observable. */
const BOOK_INLINE: ReadonlySet<ExchangeId> = new Set<ExchangeId>(['HL', 'BYBIT', 'OKX', 'BITGET', 'GATE', 'MEXC', 'HTX', 'BINGX', 'WHITEBIT', 'XT']);

/**
 * The scan SoT's ONE finalize step: admit → sort (OI-desc, stable) → slice. `meta[i]` is the admission
 * identity of `assets[i]` — the venue symbol and any payload-native evidence (a ticker timestamp).
 */
async function finalizeUniverse(
  venue: PromotedExchangeId, assets: ExchangeAsset[], meta: { symbol: string; tickerTsMs?: number }[], limit: number,
  opts: { inlineStatusPayload?: unknown } = {},
): Promise<ExchangeAsset[]> {
  const rows = assets.map((a, i) => ({
    symbol: meta[i]?.symbol ?? a.coin,
    notionalOI_usd: a.notionalOI_usd,
    volume24h_usd: a.volume24h_usd,
    hasBook: BOOK_INLINE.has(venue) ? a.bidPx !== undefined && a.askPx !== undefined : undefined,
    tickerTsMs: meta[i]?.tickerTsMs,
    asset: a,
  }));
  const kept = (await admitVenueRows(venue, rows, 'sot', opts)).map((r) => r.asset);
  kept.sort((a, b) => b.notionalOI_usd - a.notionalOI_usd);
  return kept.slice(0, limit);
}

/** HL: `metaAndAssetCtxs` returns OI + markPx + dayNtlVlm. `dayNtlVlm` is natively USD-notional. */
async function fetchHL(limit: number): Promise<ExchangeAsset[]> {
  // OPS-HL-RATELIMITER-W2: route through the shared HL weight budget (was a
  // direct fetch bypassing the adapter chokepoint).
  const raw = await hlInfoPost<[
    { universe: { name: string }[] },
    { openInterest?: string; markPx?: string; dayNtlVlm?: string; prevDayPx?: string; funding?: string;
      oraclePx?: string; impactPxs?: [string, string] | string[] }[],
  ]>({ type: 'metaAndAssetCtxs' });
  const meta = raw[0];
  const ctxs = raw[1];
  const assets: ExchangeAsset[] = meta.universe
    .map((a, i) => {
      const oi = parseFloat(ctxs[i]?.openInterest || '0');
      const px = parseFloat(ctxs[i]?.markPx || '0');
      const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
      // W1: HL ships all four inline. `oraclePx` IS the spot index (HL's own basis reference);
      // `impactPxs` is [impactBid, impactAsk] — HL's top-of-book proxy, the only book HL exposes
      // on this call. Native `premium` is deliberately NOT read: one derivation for every venue.
      const impact = ctxs[i]?.impactPxs;
      return {
        coin: a.name.toUpperCase(),
        notionalOI_usd: oi * px,
        baseOI: oi, // CH3: base-coin OI (HL openInterest)
        volume24h_usd: vol, // HL natively reports USD-notional volume
        // SCAN-RANKBY-W1: % from prevDayPx; funding is HOURLY (interval = 1h).
        changePct24h: pctChange24h(px, parseFloat(ctxs[i]?.prevDayPx || '0')),
        fundingRate: parseFunding(ctxs[i]?.funding),
        fundingIntervalHours: HL_FUNDING_INTERVAL_H,
        markPx: pos(ctxs[i]?.markPx),
        indexPx: pos(ctxs[i]?.oraclePx),
        bidPx: Array.isArray(impact) ? pos(impact[0]) : undefined,
        askPx: Array.isArray(impact) ? pos(impact[1]) : undefined,
      };
    });
  // OPS-ALARM-SINGLE-DERIVATION-W1 CH2: the historical `notionalOI_usd > 0` filter IS HL's declaration
  // (`legacy_oi_positive`) and runs inside the one finalize step — byte-identical, measured ≡ isDelisted.
  return finalizeUniverse('HL', assets, meta.universe.map((a) => ({ symbol: a.name })), limit);
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
  const usdt = data.filter((t) => t.symbol.endsWith('USDT'));
  const assets: ExchangeAsset[] = usdt
    .map((t) => {
      const qv = parseFloat(t.quoteVolume || '0');
      return {
        coin: t.symbol.replace(/USDT$/, '').toUpperCase(),
        notionalOI_usd: qv, // proxy: rank by 24h USD volume since no bulk OI endpoint
        oiIsProxy: true, // OPS-SCAN-UNIVERSE-EXPAND-W1: Binance OI is a volume proxy (real OI via oi-sources openInterestHist)
        volume24h_usd: qv, // quoteVolume is USDT-denominated (≈ USD for USDT-margined perps)
        // SCAN-RANKBY-W1: % from openPrice (futures 24h-open; prevClosePrice is spot-only —
        // OPS-TRADE-CALL-CLUSTER-W1). Funding is NOT on ticker/24hr → filled by rank-metrics.ts
        // from the bulk premiumIndex; interval default 8h.
        changePct24h: pctChange24h(parseFloat(t.lastPrice || '0'), parseFloat(t.openPrice || '0')),
        fundingIntervalHours: DEFAULT_FUNDING_INTERVAL_H,
      };
    });
  return finalizeUniverse('BINANCE', assets, usdt.map((t) => ({ symbol: t.symbol, tickerTsMs: pos((t as { closeTime?: unknown }).closeTime) })), limit);
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
      prevPrice24h?: string; fundingRate?: string; fundingIntervalHour?: number | string;
      markPrice?: string; indexPrice?: string; bid1Price?: string; ask1Price?: string }> };
  }>(VENUE_FETCH_CONFIGS.BYBIT, { url: 'https://api.bybit.com/v5/market/tickers?category=linear' });
  const usdt = json.result.list.filter((t) => t.symbol.endsWith('USDT'));
  const assets: ExchangeAsset[] = usdt
    .map((t) => {
      const oi = parseFloat(t.openInterest || '0');
      const px = parseFloat(t.lastPrice || '0');
      // SCAN-RANKBY-W1: % from prevPrice24h; funding + interval BOTH live in the tickers call.
      const interval = t.fundingIntervalHour != null ? Number(t.fundingIntervalHour) : NaN;
      return {
        coin: t.symbol.replace(/USDT$/, '').toUpperCase(),
        notionalOI_usd: oi * px,
        baseOI: oi, // CH3: base-coin OI (Bybit openInterest)
        volume24h_usd: parseFloat(t.turnover24h || '0'), // turnover24h is USDT-denominated
        changePct24h: pctChange24h(px, parseFloat(t.prevPrice24h || '0')),
        fundingRate: parseFunding(t.fundingRate),
        fundingIntervalHours: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_FUNDING_INTERVAL_H,
        // W1: all four inline. Bybit also ships native `basis`/`basisRate`, deliberately NOT read —
        // one derivation applied uniformly across venues (single-derivation LAW); the native field
        // serves only as the cross-check recorded in the wave's endpoint-truth audit.
        markPx: pos(t.markPrice),
        indexPx: pos(t.indexPrice),
        bidPx: pos(t.bid1Price),
        askPx: pos(t.ask1Price),
      };
    });
  return finalizeUniverse('BYBIT', assets, usdt.map((t) => ({ symbol: t.symbol })), limit);
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
    upstreamFetch<{ data: Array<{ instId: string; last?: string; markPx?: string; volCcy24h?: string; open24h?: string;
      bidPx?: string; askPx?: string }> }>(
      VENUE_FETCH_CONFIGS.OKX, { url: 'https://www.okx.com/api/v5/market/tickers?instType=SWAP' }),
  ]);
  const tickerMap = new Map(tickersData.data.map((t) => [t.instId, t]));
  const usdt = oiData.data.filter((o) => o.instId.endsWith('-USDT-SWAP'));
  const assets: ExchangeAsset[] = usdt
    .map((o) => {
      const ticker = tickerMap.get(o.instId);
      const px = parseFloat(ticker?.markPx || ticker?.last || '0');
      const volBase = parseFloat(ticker?.volCcy24h || '0');
      const oiBase = parseFloat(o.oiCcy || '0');
      return {
        coin: o.instId.replace(/-USDT-SWAP$/, '').toUpperCase(),
        notionalOI_usd: oiBase * px,
        baseOI: oiBase, // CH3: base-coin OI (OKX oiCcy)
        volume24h_usd: volBase * px, // Q-OKX-VOL-DENOMINATION: volCcy24h is base-denominated; multiply by markPx
        // SCAN-RANKBY-W1: % from open24h. OKX has NO bulk funding endpoint (live 50014) →
        // funding filled by rank-metrics.ts per-instId over the bounded pool; interval default 8h.
        changePct24h: pctChange24h(px, parseFloat(ticker?.open24h || '0')),
        fundingIntervalHours: DEFAULT_FUNDING_INTERVAL_H,
        // W1: `market/tickers` carries ONLY bid/ask — live `jq keys` 2026-07-21 confirms it has NO
        // `markPx` (the `ticker?.markPx` read above has always fallen through to `last`; harmless,
        // left as-is to keep `px` byte-identical). mark + index come from structural-sources'
        // two gap calls (`public/mark-price`, `market/index-tickers`).
        bidPx: pos(ticker?.bidPx),
        askPx: pos(ticker?.askPx),
      };
    });
  return finalizeUniverse('OKX', assets, usdt.map((o) => ({ symbol: o.instId })), limit);
}

/**
 * Bitget: `v2/mix/market/tickers?productType=USDT-FUTURES` returns `holdingAmount` (OI in base),
 * `markPrice`, and `quoteVolume` (USDT-denominated; verified via probe matching `usdtVolume` byte-for-byte).
 */
async function fetchBitget(limit: number): Promise<ExchangeAsset[]> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: routed through upstreamFetch (budget + typed ban/body-code).
  const json = await upstreamFetch<{
    data: Array<{ symbol: string; holdingAmount?: string; markPrice?: string; quoteVolume?: string;
      open24h?: string; lastPr?: string; fundingRate?: string;
      indexPrice?: string; bidPr?: string; askPr?: string }>;
  }>(VENUE_FETCH_CONFIGS.BITGET, { url: 'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES' });
  const usdt = json.data.filter((t) => t.symbol.endsWith('USDT'));
  const assets: ExchangeAsset[] = usdt
    .map((t) => {
      const oi = parseFloat(t.holdingAmount || '0');
      const px = parseFloat(t.markPrice || '0');
      // SCAN-RANKBY-W1: % from open24h (last = lastPr, fallback markPrice); funding in the same call.
      const last = parseFloat(t.lastPr || t.markPrice || '0');
      return {
        coin: t.symbol.replace(/USDT$/, '').toUpperCase(),
        notionalOI_usd: oi * px,
        baseOI: oi, // CH3: base-coin OI (Bitget holdingAmount)
        volume24h_usd: parseFloat(t.quoteVolume || '0'), // quoteVolume is USDT-denominated
        changePct24h: pctChange24h(last, parseFloat(t.open24h || '0')),
        fundingRate: parseFunding(t.fundingRate),
        fundingIntervalHours: DEFAULT_FUNDING_INTERVAL_H,
        markPx: pos(t.markPrice), // W1: all four inline
        indexPx: pos(t.indexPrice),
        bidPx: pos(t.bidPr),
        askPx: pos(t.askPr),
      };
    });
  return finalizeUniverse('BITGET', assets, usdt.map((t) => ({ symbol: t.symbol })), limit);
}

// ════════════════════════════════════════════════════════════════════════
// OPS-SCAN-UNIVERSE-EXPAND-W1 — rich universe fetchers for the 7 newly-promoted venues.
// Same ExchangeAsset[] contract as the original 5 (OI-desc + rank-metric fields). 5 carry REAL
// bulk OI (GATE/MEXC/KUCOIN/HTX/PHEMEX); 2 are no-bulk-OI LIQUIDITY PROXIES (ASTER/BINGX —
// oiIsProxy=true, mirroring fetchBinance). Each routes through the shared upstreamFetch (typed
// ban handling) and throws on fetch failure (callers — getTopCoinSet / the seed loop — catch &
// skip, never 500). Per-venue field divergence per the CLAUDE.md `curl <venue> | jq keys` law;
// formulas probed live 2026-06-30 (audits/OPS-SCAN-UNIVERSE-EXPAND-W1-endpoint-truth.md §4).
// ════════════════════════════════════════════════════════════════════════

/** Coerce a number | numeric-string | undefined field → finite number (0 on junk). */
function num(x: unknown): number {
  const n = typeof x === 'number' ? x : parseFloat(String(x ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/** Gate: /futures/usdt/tickers (1 call). REAL OI: total_size(contracts) × quanto_multiplier = coin
 *  OI; × mark_price = notional. volume_24h_quote = USDT vol; change_percentage is already a %. */
async function fetchGate(limit: number): Promise<ExchangeAsset[]> {
  const data = await upstreamFetch<Array<{ contract?: string; total_size?: string; quanto_multiplier?: string;
    mark_price?: string; volume_24h_quote?: string; funding_rate?: string; change_percentage?: string;
    index_price?: string; highest_bid?: string; lowest_ask?: string }>>(
    VENUE_FETCH_CONFIGS.GATE, { url: 'https://api.gateio.ws/api/v4/futures/usdt/tickers' });
  const usdt = (Array.isArray(data) ? data : []).filter((t) => typeof t.contract === 'string' && t.contract.endsWith('_USDT'));
  const assets: ExchangeAsset[] = usdt
    .map((t) => {
      const coinOI = num(t.total_size) * num(t.quanto_multiplier);
      const chgRaw = parseFloat(t.change_percentage ?? '');
      return {
        coin: (t.contract as string).replace(/_USDT$/, '').toUpperCase(),
        notionalOI_usd: coinOI * num(t.mark_price),
        baseOI: coinOI,
        volume24h_usd: num(t.volume_24h_quote),
        changePct24h: Number.isFinite(chgRaw) ? chgRaw : undefined,
        fundingRate: parseFunding(t.funding_rate),
        fundingIntervalHours: DEFAULT_FUNDING_INTERVAL_H,
        markPx: pos(t.mark_price), // W1: all four inline
        indexPx: pos(t.index_price),
        bidPx: pos(t.highest_bid),
        askPx: pos(t.lowest_ask),
      };
    });
  return finalizeUniverse('GATE', assets, usdt.map((t) => ({ symbol: t.contract as string })), limit);
}

/** MEXC: /contract/ticker + /contract/detail. REAL OI: holdVol(contracts) × contractSize(coin/contract)
 *  × lastPrice = notional. amount24 = USDT vol; riseFallRate is a FRACTION (×100). */
async function fetchMexc(limit: number): Promise<ExchangeAsset[]> {
  const [tickerData, detailData] = await Promise.all([
    upstreamFetch<{ data?: Array<{ symbol?: string; lastPrice?: number; holdVol?: number; amount24?: number;
      fundingRate?: number; riseFallRate?: number;
      fairPrice?: number; indexPrice?: number; bid1?: number; ask1?: number }> }>(
      VENUE_FETCH_CONFIGS.MEXC, { url: 'https://contract.mexc.com/api/v1/contract/ticker' }),
    upstreamFetch<{ data?: Array<{ symbol?: string; contractSize?: number }> }>(
      VENUE_FETCH_CONFIGS.MEXC, { url: 'https://contract.mexc.com/api/v1/contract/detail' }),
  ]);
  const sizeMap = new Map<string, number>();
  for (const d of detailData.data ?? []) if (d.symbol) sizeMap.set(d.symbol, num(d.contractSize));
  const usdt = (tickerData.data ?? []).filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('_USDT'));
  const assets: ExchangeAsset[] = usdt
    .map((t) => {
      const coinOI = num(t.holdVol) * (sizeMap.get(t.symbol as string) ?? 0);
      const rf = t.riseFallRate;
      return {
        coin: (t.symbol as string).replace(/_USDT$/, '').toUpperCase(),
        notionalOI_usd: coinOI * num(t.lastPrice),
        baseOI: coinOI,
        volume24h_usd: num(t.amount24),
        changePct24h: typeof rf === 'number' && Number.isFinite(rf) ? rf * 100 : undefined,
        fundingRate: typeof t.fundingRate === 'number' && Number.isFinite(t.fundingRate) ? t.fundingRate : undefined,
        fundingIntervalHours: DEFAULT_FUNDING_INTERVAL_H,
        markPx: pos(t.fairPrice), // W1: all four inline — MEXC calls its mark price `fairPrice`
        indexPx: pos(t.indexPrice),
        bidPx: pos(t.bid1),
        askPx: pos(t.ask1),
      };
    });
  return finalizeUniverse('MEXC', assets, usdt.map((t) => ({ symbol: t.symbol as string })), limit, { inlineStatusPayload: detailData });
}

/** KuCoin: /contracts/active (1 call). REAL OI: openInterest(contracts) × multiplier(coin/contract)
 *  × markPrice. turnoverOf24h = USDT vol; priceChgPct is a FRACTION (×100); fundingFeeRate on call.
 *  USDT perps = type FFWCSX + quoteCurrency USDT; baseCurrency XBT→BTC. */
async function fetchKucoin(limit: number): Promise<ExchangeAsset[]> {
  const json = await upstreamFetch<{ data?: Array<{ symbol?: string; baseCurrency?: string; quoteCurrency?: string; type?: string;
    openInterest?: string; multiplier?: number; markPrice?: number; turnoverOf24h?: number; priceChgPct?: number;
    fundingFeeRate?: number; indexPrice?: number }> }>(
    VENUE_FETCH_CONFIGS.KUCOIN, { url: 'https://api-futures.kucoin.com/api/v1/contracts/active' });
  const usdt = (json.data ?? []).filter((c) => c.quoteCurrency === 'USDT' && c.type === 'FFWCSX' && typeof c.baseCurrency === 'string');
  const assets: ExchangeAsset[] = usdt
    .map((c) => {
      const coinOI = num(c.openInterest) * num(c.multiplier);
      const chg = c.priceChgPct;
      return {
        coin: c.baseCurrency === 'XBT' ? 'BTC' : (c.baseCurrency as string).toUpperCase(),
        notionalOI_usd: coinOI * num(c.markPrice),
        baseOI: coinOI,
        volume24h_usd: num(c.turnoverOf24h),
        changePct24h: typeof chg === 'number' && Number.isFinite(chg) ? chg * 100 : undefined,
        fundingRate: typeof c.fundingFeeRate === 'number' && Number.isFinite(c.fundingFeeRate) ? c.fundingFeeRate : undefined,
        fundingIntervalHours: DEFAULT_FUNDING_INTERVAL_H,
        // W1: `contracts/active` carries mark+index but NO book — bid/ask come from the
        // structural-sources gap call (`api/v1/allTickers` → bestBidPrice/bestAskPrice).
        markPx: pos(c.markPrice),
        indexPx: pos(c.indexPrice),
      };
    });
  return finalizeUniverse('KUCOIN', assets, usdt.map((c) => ({ symbol: c.symbol ?? '' })), limit, { inlineStatusPayload: json });
}

/** HTX: /linear-swap-api/v1/swap_open_interest (value = USD-notional OI; amount = coin OI) joined by
 *  contract_code with /linear-swap-ex/market/detail/batch_merged (close, open, trade_turnover USDT
 *  vol). USDT swaps = "<COIN>-USDT". Funding omitted → augmentFunding / fail-soft. */
async function fetchHtx(limit: number): Promise<ExchangeAsset[]> {
  const [oiData, tickData] = await Promise.all([
    upstreamFetch<{ data?: Array<{ contract_code?: string; amount?: number; value?: number }> }>(
      VENUE_FETCH_CONFIGS.HTX, { url: 'https://api.hbdm.com/linear-swap-api/v1/swap_open_interest' }),
    upstreamFetch<{ ticks?: Array<{ contract_code?: string; close?: number | string;
      trade_turnover?: number | string; open?: number | string;
      bid?: Array<number | string>; ask?: Array<number | string> }> }>(
      VENUE_FETCH_CONFIGS.HTX, { url: 'https://api.hbdm.com/linear-swap-ex/market/detail/batch_merged' }),
  ]);
  const tickMap = new Map<string, { close?: number | string; trade_turnover?: number | string; open?: number | string;
    bid?: Array<number | string>; ask?: Array<number | string> }>();
  for (const t of tickData.ticks ?? []) if (t.contract_code) tickMap.set(t.contract_code, t);
  const usdt = (oiData.data ?? []).filter((o) => typeof o.contract_code === 'string' && o.contract_code.endsWith('-USDT'));
  const assets: ExchangeAsset[] = usdt
    .map((o) => {
      const tk = tickMap.get(o.contract_code as string);
      const px = num(tk?.close);
      const coinOI = num(o.amount);
      return {
        coin: (o.contract_code as string).replace(/-USDT$/, '').toUpperCase(),
        notionalOI_usd: num(o.value) || coinOI * px,
        baseOI: coinOI,
        volume24h_usd: num(tk?.trade_turnover),
        changePct24h: pctChange24h(px, num(tk?.open)),
        fundingIntervalHours: DEFAULT_FUNDING_INTERVAL_H,
        // W1: HTX `batch_merged` ships bid/ask as [price, size] tuples (live-probed 2026-07-21:
        // "bid":[59.53,183]). Index comes from the structural-sources gap call (`swap_index`);
        // HTX exposes NO bulk mark-price endpoint → markPx stays undefined ⇒ NULL, counted.
        bidPx: Array.isArray(tk?.bid) ? pos(tk?.bid[0]) : undefined,
        askPx: Array.isArray(tk?.ask) ? pos(tk?.ask[0]) : undefined,
      };
    });
  return finalizeUniverse('HTX', assets, usdt.map((o) => ({ symbol: o.contract_code as string })), limit);
}

/** Phemex: /md/v2/ticker/24hr/all — v2 "Rv/Rp/Rr" fields are REAL-value (unscaled). openInterestRv(coin
 *  OI) × markPriceRp = notional; turnoverRv = USDT vol; (closeRp−openRp)/openRp = 24h%; fundingRateRr.
 *  USDT perps = symbol ending "USDT". */
async function fetchPhemex(limit: number): Promise<ExchangeAsset[]> {
  const json = await upstreamFetch<{ result?: Array<{ symbol?: string; openInterestRv?: string; markPriceRp?: string;
    turnoverRv?: string; openRp?: string; closeRp?: string; fundingRateRr?: string; indexPriceRp?: string }> }>(
    VENUE_FETCH_CONFIGS.PHEMEX, { url: 'https://api.phemex.com/md/v2/ticker/24hr/all' });
  const usdt = (json.result ?? []).filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('USDT'));
  const assets: ExchangeAsset[] = usdt
    .map((t) => {
      const coinOI = num(t.openInterestRv);
      return {
        coin: (t.symbol as string).replace(/USDT$/, '').toUpperCase(),
        notionalOI_usd: coinOI * num(t.markPriceRp),
        baseOI: coinOI,
        volume24h_usd: num(t.turnoverRv),
        changePct24h: pctChange24h(num(t.closeRp), num(t.openRp)),
        fundingRate: parseFunding(t.fundingRateRr),
        fundingIntervalHours: DEFAULT_FUNDING_INTERVAL_H,
        // W1: v2 carries mark+index but NO book — bid/ask come from the structural-sources gap
        // call (`md/v3/ticker/24hr/all` → bidRp/askRp). The universe stays on v2 deliberately:
        // migrating this hot path to v3 is a separate, wider change than this wave's scope.
        markPx: pos(t.markPriceRp),
        indexPx: pos(t.indexPriceRp),
      };
    });
  return finalizeUniverse('PHEMEX', assets, usdt.map((t) => ({ symbol: t.symbol as string })), limit);
}

/** Aster: Binance-fork /fapi/v1/ticker/24hr — NO bulk OI ⇒ LIQUIDITY PROXY (oiIsProxy=true,
 *  notionalOI_usd = quoteVolume; mirrors fetchBinance). priceChangePercent = 24h%. */
async function fetchAster(limit: number): Promise<ExchangeAsset[]> {
  const data = await upstreamFetch<Array<{ symbol?: string; quoteVolume?: string; lastPrice?: string;
    openPrice?: string; priceChangePercent?: string; closeTime?: number }>>(
    VENUE_FETCH_CONFIGS.ASTER, { url: 'https://fapi.asterdex.com/fapi/v1/ticker/24hr' });
  const usdt = (Array.isArray(data) ? data : []).filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('USDT'));
  const assets: ExchangeAsset[] = usdt
    .map((t) => {
      const qv = num(t.quoteVolume);
      const pcp = parseFloat(t.priceChangePercent ?? '');
      return {
        // Aster is a Binance-fork → apply the shared 1000× meme overrides (1000PEPE → PEPE) so the
        // delegated seed + scan match the signal engine's canonical symbol (never drop the coin).
        coin: normalizeBinanceCoin((t.symbol as string).replace(/USDT$/, '').toUpperCase()),
        notionalOI_usd: qv,
        oiIsProxy: true,
        volume24h_usd: qv,
        changePct24h: Number.isFinite(pcp) ? pcp : pctChange24h(num(t.lastPrice), num(t.openPrice)),
        fundingIntervalHours: DEFAULT_FUNDING_INTERVAL_H,
      };
    });
  return finalizeUniverse('ASTER', assets, usdt.map((t) => ({ symbol: t.symbol as string, tickerTsMs: pos(t.closeTime) })), limit);
}

/** BingX: /openApi/swap/v2/quote/ticker — NO bulk OI ⇒ LIQUIDITY PROXY (oiIsProxy=true,
 *  notionalOI_usd = quoteVolume). symbol "<COIN>-USDT"; priceChangePercent = 24h%. */
async function fetchBingx(limit: number): Promise<ExchangeAsset[]> {
  const json = await upstreamFetch<{ data?: Array<{ symbol?: string; quoteVolume?: string;
    priceChangePercent?: string; bidPrice?: string | number; askPrice?: string | number }> }>(
    VENUE_FETCH_CONFIGS.BINGX, { url: 'https://open-api.bingx.com/openApi/swap/v2/quote/ticker' });
  const usdt = (json.data ?? []).filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('-USDT'));
  const assets: ExchangeAsset[] = usdt
    .map((t) => {
      const qv = num(t.quoteVolume);
      const pcp = parseFloat(t.priceChangePercent ?? '');
      return {
        coin: (t.symbol as string).replace(/-USDT$/, '').toUpperCase(),
        notionalOI_usd: qv,
        oiIsProxy: true,
        volume24h_usd: qv,
        changePct24h: Number.isFinite(pcp) ? pcp : undefined,
        fundingIntervalHours: DEFAULT_FUNDING_INTERVAL_H,
        // W1: BingX ships the book inline; mark+index come from the structural-sources gap call
        // (`swap/v2/quote/premiumIndex`). OI stays a volume proxy — structural ≠ OI (Q4).
        bidPx: pos(t.bidPrice),
        askPx: pos(t.askPrice),
      };
    });
  return finalizeUniverse('BINGX', assets, usdt.map((t) => ({ symbol: t.symbol as string })), limit);
}

// ════════════════════════════════════════════════════════════════════════
// OPS-VENUE-GO-LIVE-15-W1 — rich universe fetchers for the 3 newly-promoted venues (12→15).
// Field semantics live-probed 2026-07-23 (audits/OPS-VENUE-GO-LIVE-15-W1-endpoint-truth.md §C):
// BITMART + WHITEBIT carry REAL bulk OI; XT has NO OI endpoint (adapter openInterest:0) ⇒ a
// 24h-VOLUME liquidity proxy (oiIsProxy=true, in OI_PROXY_VENUES), mirroring ASTER/BINGX.
// ════════════════════════════════════════════════════════════════════════

/** BitMart: /contract/public/details (1 call, all perps). REAL OI: `open_interest_value` is the
 *  USD-notional OI DIRECT (probed BTC $219M ≈ open_interest×contract_size×index $213M). turnover_24h =
 *  USDT vol; change_24h is a FRACTION (×100); funding_interval_hours native. No mark_price field ⇒
 *  markPx undefined (NULL, counted — never substitute mark from last/index). No bulk book. */
async function fetchBitmart(limit: number): Promise<ExchangeAsset[]> {
  const json = await upstreamFetch<{ data?: { symbols?: Array<{ symbol?: string; product_type?: number;
    quote_currency?: string; open_interest_value?: string; open_interest?: string; contract_size?: string;
    turnover_24h?: string; index_price?: string; funding_rate?: string; change_24h?: string;
    funding_interval_hours?: number }> } }>(
    VENUE_FETCH_CONFIGS.BITMART, { url: 'https://api-cloud-v2.bitmart.com/contract/public/details' });
  const assets: ExchangeAsset[] = (json.data?.symbols ?? [])
    .filter((s) => s.product_type === 1 && s.quote_currency === 'USDT' && typeof s.symbol === 'string')
    .map((s) => {
      const chg = parseFloat(s.change_24h ?? '');
      const fih = s.funding_interval_hours;
      return {
        coin: (s.symbol as string).replace(/USDT$/, '').toUpperCase(),
        notionalOI_usd: num(s.open_interest_value),          // BitMart ships USD-notional OI directly
        baseOI: num(s.open_interest) * num(s.contract_size), // contracts × coin/contract = coin OI
        volume24h_usd: num(s.turnover_24h),                  // USDT-denominated 24h turnover
        changePct24h: Number.isFinite(chg) ? chg * 100 : undefined, // change_24h is a signed fraction
        fundingRate: parseFunding(s.funding_rate),
        fundingIntervalHours: typeof fih === 'number' && fih > 0 ? fih : DEFAULT_FUNDING_INTERVAL_H,
        indexPx: pos(s.index_price),
      };
    });
  assets.sort((a, b) => b.notionalOI_usd - a.notionalOI_usd);
  return assets.slice(0, limit);
}

/** WhiteBIT: /api/v4/public/futures (1 call, all 396 markets). REAL OI: `open_interest` is BASE-coin
 *  OI (probed BTC 24689 × index $65777 = $1.62B) → × last_price = notional. money_volume = USDT vol;
 *  funding_interval_minutes → /60 hours; bid/ask/index inline. WhiteBIT exposes NO mark_price ⇒
 *  markPx undefined (NULL, counted). */
async function fetchWhitebit(limit: number): Promise<ExchangeAsset[]> {
  const json = await upstreamFetch<{ result?: Array<{ ticker_id?: string; money_currency?: string;
    open_interest?: string; last_price?: string; index_price?: string; money_volume?: string;
    funding_rate?: string; funding_interval_minutes?: number; bid?: string; ask?: string }> }>(
    VENUE_FETCH_CONFIGS.WHITEBIT, { url: 'https://whitebit.com/api/v4/public/futures' });
  const usdt = (json.result ?? []).filter((m) => typeof m.ticker_id === 'string' && m.ticker_id.endsWith('_PERP') && m.money_currency === 'USDT');
  const assets: ExchangeAsset[] = usdt
    .map((m) => {
      const px = num(m.last_price) || num(m.index_price);
      const fim = m.funding_interval_minutes;
      return {
        coin: (m.ticker_id as string).replace(/_PERP$/, '').toUpperCase(),
        notionalOI_usd: num(m.open_interest) * px,   // open_interest is base-coin OI; × price = USD
        baseOI: num(m.open_interest),
        volume24h_usd: num(m.money_volume),          // money_volume = USDT-denominated 24h vol
        fundingRate: parseFunding(m.funding_rate),
        fundingIntervalHours: typeof fim === 'number' && fim > 0 ? fim / 60 : DEFAULT_FUNDING_INTERVAL_H,
        indexPx: pos(m.index_price),
        bidPx: pos(m.bid),
        askPx: pos(m.ask),
      };
    });
  return finalizeUniverse('WHITEBIT', assets, usdt.map((m) => ({ symbol: m.ticker_id as string })), limit);
}

/** XT: /future/market/v1/public/q/agg-tickers (1 bulk call). NO OI endpoint (adapter openInterest:0)
 *  ⇒ LIQUIDITY PROXY: notionalOI_usd = v (quote/USDT volume ≈ USD, probed BTC $966M — a=base vol).
 *  symbol `<coin>_usdt` lowercase; r = signed 24h change FRACTION (×100); m/i/bp/ap inline (real). */
async function fetchXt(limit: number): Promise<ExchangeAsset[]> {
  const env = await upstreamFetch<{ result?: Array<{ s?: string; c?: string; v?: string; r?: string;
    m?: string; i?: string; bp?: string; ap?: string; t?: number | string }> }>(
    VENUE_FETCH_CONFIGS.XT, { url: 'https://fapi.xt.com/future/market/v1/public/q/agg-tickers' });
  const rows = Array.isArray(env?.result) ? env.result : [];
  const usdt = rows.filter((t) => typeof t.s === 'string' && t.s.endsWith('_usdt'));
  const assets: ExchangeAsset[] = usdt
    .map((t) => {
      const qv = num(t.v);   // v = quote (USDT) volume ≈ USD; a = base-coin volume
      const r = parseFloat(t.r ?? '');
      return {
        coin: (t.s as string).replace(/_usdt$/, '').toUpperCase(),
        notionalOI_usd: qv,   // proxy: XT exposes no bulk OI
        oiIsProxy: true,
        volume24h_usd: qv,
        changePct24h: Number.isFinite(r) ? r * 100 : undefined,   // r is a signed fraction
        fundingIntervalHours: DEFAULT_FUNDING_INTERVAL_H,          // XT funding 8h; rate not on this call
        markPx: pos(t.m),   // XT agg-tickers ships mark + index + book inline (zero extra call)
        indexPx: pos(t.i),
        bidPx: pos(t.bp),
        askPx: pos(t.ap),
      };
    });
  return finalizeUniverse('XT', assets, usdt.map((t) => ({ symbol: t.s as string, tickerTsMs: pos(t.t) })), limit);
}

/** WEEX: /capi/v3/market/ticker/24hr (1 bulk call, 1023 perps). NO USABLE OI ⇒ LIQUIDITY PROXY:
 *  notionalOI_usd = quoteVolume (USDT-denominated, probed 2026-09-04: BTC $3.00B, and
 *  volume 37355.87 BTC × lastPrice 80886.2 = $3.02B, so quoteVolume is genuinely quote-side).
 *  symbol `<COIN>USDT` uppercase; priceChangePercent is a signed FRACTION (×100 — probed
 *  3109.1/77777.1 = 0.03997); markPrice + indexPrice inline (real, zero extra call); no book,
 *  no funding rate on this endpoint. WEEX funding is 4h, NOT the 8h default (adapters/weex.ts:218).
 *
 *  WHY THE PROXY AND NOT REAL OI — architect ruling Q7[A], OPS-WEEX-PROMOTION-READINESS-W1 CH3.
 *  The decisive argument is the UNIT, not the latency. `/capi/v3/market/openInterest` is
 *  PER-SYMBOL only (no `symbol` ⇒ -1141), so ranking 1023 symbols costs 1023 calls ≈ 41 min at
 *  the venue's 2400 ms pacing — but the disqualifier is that its unit does not reconcile: BTC
 *  renders as $10.9B (base-units) or $1.09M (contractVal-notional) depending on which reading of
 *  `contractVal` you take, and `contractVal` spans 0.0001 → 100. We cannot publish a magnitude we
 *  cannot defend, so an UNINTERPRETABLE OI figure is a Factuality hazard while a LABELLED volume
 *  proxy is honest. `quoteVolume` already carries the ranking signal: Spearman +0.84 against the
 *  real OI series. Joins OI_PROXY_VENUES alongside BINANCE/ASTER/BINGX/XT. */
async function fetchWeex(limit: number): Promise<ExchangeAsset[]> {
  const rows = await upstreamFetch<Array<{ symbol?: string; quoteVolume?: string; lastPrice?: string;
    priceChangePercent?: string; markPrice?: string; indexPrice?: string }>>(
    VENUE_FETCH_CONFIGS.WEEX, { url: 'https://api-contract.weex.com/capi/v3/market/ticker/24hr' });
  const usdt = (Array.isArray(rows) ? rows : []).filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('USDT'));
  const assets: ExchangeAsset[] = usdt
    .map((t) => {
      const qv = num(t.quoteVolume);   // USDT-denominated 24h turnover ≈ USD
      const pcp = parseFloat(t.priceChangePercent ?? '');
      return {
        coin: (t.symbol as string).replace(/USDT$/, '').toUpperCase(),
        notionalOI_usd: qv,   // proxy: WEEX exposes no interpretable bulk OI
        oiIsProxy: true,
        volume24h_usd: qv,
        changePct24h: Number.isFinite(pcp) ? pcp * 100 : undefined,   // priceChangePercent is a fraction
        fundingIntervalHours: 4,   // WEEX is 4h, not the 8h default; rate is not on this call
        markPx: pos(t.markPrice),
        indexPx: pos(t.indexPrice),
      };
    });
  return finalizeUniverse('WEEX', assets, usdt.map((t) => ({ symbol: t.symbol as string })), limit);
}

// OPS-SCAN-UNIVERSE-EXPAND-W1: the unified venue→universe SoT, keyed by the EXCHANGES-derived
// PromotedExchangeId — tsc fails if a promoted venue lacks a fetcher. OPS-VENUE-GO-LIVE-15-W1: now
// 15 (5 original + 7 + 3 new). 11 real-OI + 4 volume-proxy (BINANCE via oi-sources openInterestHist,
// ASTER/BINGX/XT no bulk OI). The seed loop's UNIVERSE_FETCHERS projects `.coin` off these.
const FETCHERS: Record<PromotedExchangeId, (limit: number) => Promise<ExchangeAsset[]>> = {
  HL: fetchHL,
  BINANCE: fetchBinance,
  BYBIT: fetchBybit,
  OKX: fetchOKX,
  BITGET: fetchBitget,
  ASTER: fetchAster,
  BINGX: fetchBingx,
  GATE: fetchGate,
  HTX: fetchHtx,
  KUCOIN: fetchKucoin,
  MEXC: fetchMexc,
  PHEMEX: fetchPhemex,
  WHITEBIT: fetchWhitebit,
  XT: fetchXt,
  WEEX: fetchWeex,   // OPS-WEEX-PROMOTE-W1 — volume proxy, see fetchWeex
};

/**
 * Venues whose `notionalOI_usd` is a 24h-VOLUME liquidity proxy (no bulk OI endpoint). The OI sampler
 * + oi_change lens MUST skip these (never record volume as OI). BINANCE keeps a real-OI special-case
 * in oi-sources (openInterestHist); ASTER/BINGX have none. Honest-labeling contract.
 */
export const OI_PROXY_VENUES: ReadonlySet<ExchangeId> = new Set<ExchangeId>(['BINANCE', 'ASTER', 'BINGX', 'XT', 'WEEX']);

/**
 * The USD liquidity figure to gate an asset on — ONE derivation, two consumers.
 *
 * A venue that exposes no bulk-OI endpoint carries a 24h-VOLUME proxy in
 * `notionalOI_usd` and flags it via `oiIsProxy` (see `OI_PROXY_VENUES` above).
 * Reading `notionalOI_usd` unconditionally would compare a volume number against an
 * OI threshold on those venues and silently mis-gate them.
 *
 * `scan_funding_arb`'s per-leg gate has always applied this rule inline;
 * FIX-CONVICTION-CALL-POSTS-W1 made the scan universe a SECOND consumer, so the rule
 * moved here rather than being written twice (CLAUDE.md single-derivation: two
 * independent re-derivations drift to contradiction).
 *
 * Returns 0 for an absent or non-finite figure, so every caller default-DENIES: an
 * asset whose liquidity we cannot establish must never clear a liquidity floor.
 */
export function effectiveLiquidityUsd(
  asset: Pick<ExchangeAsset, 'notionalOI_usd' | 'volume24h_usd' | 'oiIsProxy'>,
): number {
  const v = asset.oiIsProxy ? asset.volume24h_usd : asset.notionalOI_usd;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Fetch top-N USDT-margined perps on `exchange` by notional OI (or volume proxy for proxy venues).
 * Sorted desc by `notionalOI_usd`; at most `limit` entries.
 *
 * OPS-SCAN-UNIVERSE-EXPAND-W1: covers all 12 promoted venues (was the 5). FAIL-SOFT — an exchange with
 * no fetcher (non-promoted / unknown) returns `[]` + a warn (was a throw), so it never crashes a caller.
 */
export async function getExchangeTopAssetsWithVolume(
  exchange: ExchangeId,
  limit: number,
): Promise<ExchangeAsset[]> {
  const fetcher = FETCHERS[exchange as PromotedExchangeId];
  if (!fetcher) {
    console.warn(`[exchange-universe] getExchangeTopAssetsWithVolume: '${exchange}' is not a promoted venue with a universe fetcher — returning [] (fail-soft)`);
    return [];
  }
  return fetcher(limit);
}

/**
 * SCAN-RANKBY-W1: the FULL rich USDT-perp universe on `exchange` (OI-desc, NO slice), each asset
 * carrying the rank-metric fields. `getRankedUniverse` (rank-metrics.ts) re-sorts by the chosen lens.
 * OPS-SCAN-UNIVERSE-EXPAND-W1: all 12 promoted; FAIL-SOFT (no fetcher → `[]` + warn, not throw).
 */
export async function fetchVenueUniverse(exchange: ExchangeId): Promise<ExchangeAsset[]> {
  const fetcher = FETCHERS[exchange as PromotedExchangeId];
  if (!fetcher) {
    console.warn(`[exchange-universe] fetchVenueUniverse: '${exchange}' has no universe fetcher — returning [] (fail-soft)`);
    return [];
  }
  return fetcher(Number.MAX_SAFE_INTEGER);
}
