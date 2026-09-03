/**
 * WEEX adapter — PILOT-ADAPTERS-W3B C1, 2026-05-20.
 *
 * MIGRATED TO /capi/v3 by OPS-WEEX-PROMOTION-READINESS-W1 CH2 (2026-09-03) ahead of the
 * announced V2 sunset — see the version note above INTERVAL_MAP for the three things V3
 * changed and how each was probed. Symbol convention is now <COIN>USDT (uppercase, no
 * `cmt_` prefix); the historical V2 form was cmt_<coin>usdt, the most-divergent W3B
 * convention among 13 prior adapters.
 *
 * Funding cadence 4h (×2190 annualization, NOT ×1095) per contract metadata delivery
 * field [00,04,08,12,16,20]. First non-8h venue in adapter fleet. Adapter still returns
 * funding=0 + openInterest=0 (fail-soft per W3B Plan-Mode Q-3 ratification 2026-05-20)
 * — but W3B's "no public funding/OI endpoints surfaced" is REFUTED on V3, which serves
 * both; wiring them is a new capability and a separate wave (see `getAssetContext`).
 * Ticker bundles markPrice + indexPrice + openPrice + 24h vol + lastPrice.
 *
 * TRADFI_ALIASES (4): SILVER→XAG, PLATINUM→XPT, PALLADIUM→XPD, USOIL→CL.
 *
 * ⚠️ CORRECTED 2026-09-03 (OPS-WEEX-PROMOTION-READINESS-W1 CH2): this docblock said
 * "WEEX has NO XAU/GOLD listing", recorded from the 2026-05-20 W3B pilot. That is now
 * FALSE — V3 `exchangeInfo` lists `XAUUSDT` (`GOLDUSDT` is still absent), and the live
 * seed lane already scores it (`[WEEX] XAU -> HOLD (18%) @ $4,429.82`, a plausible gold
 * price). No alias is needed or added: `XAU` reaches the venue unaliased and resolves,
 * exactly as `TSLA`/`NVDA` do. Recorded rather than acted on because adding a GOLD→XAU
 * alias would be a behaviour change, which CH2's firewall forbids.
 *
 * SPX intentionally NOT aliased — SPXUSDT = $0.37 SPX6900 memecoin per
 * semantic-fingerprint probe 2026-05-20 (5th sighting). WEEX has NO real S&P 500 perp.
 */
import type {
  ExchangeAdapter,
  Candle,
  AssetContext,
  FundingData,
  DexType,
} from '../../types.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS, safeUpstreamNum } from './_upstream-fetch.js';
import { reconstructPrevDayOpen } from './_prev-day-open.js';
import { makeServedIntervalMs } from '../served-interval.js';

const BASE_URL = 'https://api-contract.weex.com';
const MAX_RETRIES = 1;
const KLINE_LIMIT = 1000;

/**
 * OPS-WEEX-PROMOTION-READINESS-W1 CH2 — V2 → V3.
 *
 * WEEX announced the V2 sunset in two dated V3-changelog entries (2026-03-09 *"V3 will
 * receive ongoing maintenance while V2 is sunset"*; 2026-03-18 *"V2 will be retired and
 * no longer maintained"*) and its docs banner reads **"V2 (Sunsets Sep 30)"** with the
 * year genuinely absent. The V2 changelog's last entry is 2025-12-29; the V3 changelog
 * was active 2026-09-01. Working deadline: **2026-09-30**, stated as an assumption.
 *
 * V3 is NOT a path rename. Three things changed, each probed live 2026-09-03 rather than
 * assumed (CLAUDE.md: never assume cross-venue field-name uniformity — the same applies
 * across a vendor's own API versions):
 *
 *   1. SYMBOL CONVENTION — `cmt_btcusdt` → `BTCUSDT`. V3 answers a `cmt_` symbol with
 *      `-1142 Parameter 'symbol' is invalid`.
 *   2. `/capi/v3/market/tickers` DOES NOT EXIST (404). The real path is
 *      `/capi/v3/market/ticker/24hr`, which serves both per-symbol and bulk.
 *   3. VOLUME UNITS INVERTED. V2 `volume_24h` is QUOTE volume (1,794,123,988 for BTC);
 *      V3 `volume` is BASE volume (23,227.70) and the V2 equivalent is `quoteVolume`.
 *      A name-match mapping would have deflated volume ~77,000× and silently reordered
 *      the universe ranking `fetchWeexCoins` drives.
 */
const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '12h': '12h', '1d': '1d',
  '3m': '5m', '2h': '1h', '8h': '4h',
};

/**
 * OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms WEEX fetches for `tf`.
 *
 * OPS-WEEX-PROMOTION-READINESS-W1 CH2 — `30m` and `12h` are now served NATIVELY. The
 * former `30m→15m` and `12h→4h` downgrades were **V2 artifacts, not venue limitations**:
 * V3 `exchangeInfo` serves `1m 5m 15m 30m 1h 4h 12h 1d 1w`. Carrying them onto V3 would
 * ship a knowingly obsolete mapping and cost extra base candles to aggregate on the one
 * venue with an unresolved 60× rate-limit ambiguity. `3m→5m` (1.67× coarser, under the
 * 2× faithful bar), `2h→1h` and `8h→4h` (finer) remain — V3 serves none of those three.
 */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MAP);

export const TRADFI_ALIASES: Record<string, string> = {
  SILVER: 'XAG', PLATINUM: 'XPT', PALLADIUM: 'XPD', USOIL: 'CL',
};

/**
 * `toWeexSymbol` does TWO jobs and V3 changes only the FORMAT half.
 *
 * The alias half is load-bearing and its loss would be SILENT: measured 2026-09-03
 * against V3 `exchangeInfo`, all four aliases exist under their native tickers
 * (`XAGUSDT` `XPTUSDT` `XPDUSDT` `CLUSDT`) and all four naive forms (`SILVERUSDT`,
 * `PLATINUMUSDT`, `PALLADIUMUSDT`, `USOILUSDT`) are **ABSENT**. A rewrite that dropped
 * the alias map would break every WEEX TradFi perp with no error anywhere.
 * Pinned by the round-trip test in `tests/unit/weex-adapter.test.ts`.
 */
export function toWeexSymbol(coin: string): string {
  const mapped = TRADFI_ALIASES[coin] || coin;
  return mapped.toUpperCase() + 'USDT';
}

export function fromWeexSymbol(symbol: string): string {
  const base = symbol.replace(/^cmt_/i, '').replace(/usdt$/i, '').toUpperCase();
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native.toUpperCase() === base) return canon;
  }
  return base;
}

async function weexGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build unchanged; fetch/retry/ban via upstreamFetch.
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  return upstreamFetch<T>({ ...VENUE_FETCH_CONFIGS.WEEX, transientRetries: retries }, { url: url.toString() });
}

/**
 * V3 `/capi/v3/market/ticker/24hr?symbol=X` answers with a one-element ARRAY where V2's
 * `/capi/v2/market/ticker` answered with a bare object; the bulk form (no `symbol`)
 * returns all 1023. Both single shapes are accepted so a payload change cannot silently
 * yield `undefined`.
 *
 * The identity assertion is NOT defensive padding — it is the estate's list-endpoint rule
 * ("a filtered-list endpoint can silently ignore the filter and return a wrong-but-plausible
 * row for every query"). Taking `[0]` from a filtered list without checking `symbol` is
 * exactly how a whole venue ends up scored on BTC's prices.
 */
export function weexTicker(payload: WeexTicker | WeexTicker[] | null | undefined, requested: string): WeexTicker | null {
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (!row || typeof row.symbol !== 'string') return null;
  if (row.symbol.toUpperCase() !== requested.toUpperCase()) {
    throw new Error(`WEEX: ticker identity mismatch — requested ${requested}, received ${row.symbol}`);
  }
  return row;
}

/**
 * V3 kline row — Binance-shaped, 11 fields (V2's was 7):
 * `[openTime, open, high, low, close, volume, closeTime, quoteVolume, trades,
 *   takerBuyBase, takerBuyQuote]`.
 * `openTime` is a NUMBER on V3 and was a STRING on V2; indices 0-5 otherwise line up,
 * and index 5 is BASE volume on both (V2 `base_volume`), so the candle mapping below is
 * index-identical. Verified candle-for-candle — see the equivalence note on `getCandles`.
 */
type WeexKlineRow = [number, string, string, string, string, string, number, string, number, string, string];

/** V3 `/capi/v3/market/ticker/24hr`. Keys PROBED live 2026-09-03, never assumed. */
interface WeexTicker {
  symbol: string;
  lastPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  /** BASE volume (V2 called this `base_volume`). NOT the V2 `volume_24h`. */
  volume: string;
  /** QUOTE volume — this is the V2 `volume_24h` equivalent. */
  quoteVolume: string;
  /** A FRACTION on both versions (0.0139 = 1.39%) — re-verified against `openPrice` to 2.5e-7. */
  priceChangePercent: string;
  priceChange: string;
  markPrice: string;
  indexPrice: string;
  openTime: number;
  closeTime: number;
}

export class WeexAdapter implements ExchangeAdapter {
  getName(): string { return 'WEEX'; }

  /**
   * V3 `/capi/v3/market/klines` — `interval`, not V2's `granularity`.
   *
   * EQUIVALENCE PROVEN, not assumed (2026-09-03, 3 symbols × 3 intervals including the
   * `SILVER→XAG` alias): every CLOSED bar is byte-identical between V2 and V3 on OHLC and
   * base volume. The only per-series difference is the newest, still-OPEN bar, whose
   * volume ticks between two fetches 2.5 s apart — i.e. liveness, not a data change.
   */
  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const symbol = toWeexSymbol(coin);
    const mapped = INTERVAL_MAP[interval] || '1h';
    const rows = await weexGet<WeexKlineRow[]>('/capi/v3/market/klines', { symbol, interval: mapped, limit: KLINE_LIMIT });
    if (!Array.isArray(rows)) {
      throw new Error(`WEEX: kline returned non-array shape for ${coin} (symbol=${symbol})`);
    }
    // SV-04: drop a candle whose OHLC does not parse strictly rather than emit a
    // NaN/wrong-but-finite price into the signal engine.
    // V3 emits `openTime` as a NUMBER where V2 emitted a STRING; Number() accepts both,
    // so a mixed/legacy payload degrades to NaN rather than parseInt's silent prefix-parse.
    return rows
      .filter(r => Number(r[0]) >= startTime)
      .flatMap(r => {
        const open = safeUpstreamNum(r[1]);
        const high = safeUpstreamNum(r[2]);
        const low = safeUpstreamNum(r[3]);
        const close = safeUpstreamNum(r[4]);
        if (open === null || high === null || low === null || close === null) return [];
        return [{
          time: Number(r[0]),
          open, high, low, close,
          volume: parseFloat(r[5]),
        }];
      })
      .sort((a, b) => a.time - b.time);
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const symbol = toWeexSymbol(coin);
    const t = weexTicker(await weexGet<WeexTicker | WeexTicker[]>('/capi/v3/market/ticker/24hr', { symbol }), symbol);
    if (!t || !t.symbol) {
      throw new Error(`WEEX: empty ticker payload for ${coin} (symbol=${symbol})`);
    }
    // WEEX 4h funding cadence × 2190 annualization (first non-8h venue).
    // Funding stays 0 per W3B Q-3 fail-soft. NOT because V3 lacks it — V3 serves
    // `lastFundingRate` + `forecastFundingRate` for all 1023 symbols in ONE bulk
    // `/capi/v3/market/premiumIndex` call, and a per-symbol `openInterest` endpoint
    // exists too. Wiring either is a NEW CAPABILITY, which CH2's firewall forbids
    // ("no behaviour change beyond the endpoint move; new features").
    // Owner: OPS-WEEX-V3-FUNDING-AND-OI-W{NEXT}.
    const fundingRaw = 0;
    // SV-04: default-deny — an invalid markPrice throws (the 3-tier fallback fires)
    // rather than scoring a wrong-but-finite price; non-price fields fall back to a
    // safe neutral 0. Same contract as the aster adapter.
    const last = safeUpstreamNum(t.lastPrice) ?? 0;
    const markPx = safeUpstreamNum(t.markPrice);
    if (markPx === null) throw new Error('WEEX getAssetContext: invalid markPrice');
    // V3 serves `openPrice` DIRECTLY — the 24h-prior field the per-venue divergence
    // rule exists for. `reconstructPrevDayOpen` was a V2 workaround for its absence;
    // measured 2026-09-03 the two agree to 2.5e-7 (76530.1191 reconstructed vs
    // 76530.1000 served), so preferring the served field is behaviour-preserving AND
    // removes a derivation. The reconstruction stays as the fallback: V3
    // `priceChangePercent` is a FRACTION on both versions (re-verified), so the
    // fallback's contract is unchanged — do NOT divide by 100.
    const prevDayPx = safeUpstreamNum(t.openPrice) ?? reconstructPrevDayOpen(
      last,
      safeUpstreamNum(t.priceChangePercent) ?? NaN,
      safeUpstreamNum(t.highPrice) ?? undefined,
      safeUpstreamNum(t.lowPrice) ?? undefined,
    );
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 2190,
      openInterest: 0,
      prevDayPx,
      // V2 `volume_24h` was QUOTE volume; V3's same-named `volume` is BASE. The
      // equivalent is `quoteVolume` — see the version note at the top of this file.
      volume24h: parseFloat(t.quoteVolume || '0'),
      oraclePx: safeUpstreamNum(t.indexPrice) ?? markPx,
      markPx,
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    return [];
  }

  async getFundingHistory(_coin: string, _startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    return [];
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const symbol = toWeexSymbol(coin);
      const t = weexTicker(await weexGet<WeexTicker | WeexTicker[]>('/capi/v3/market/ticker/24hr', { symbol }), symbol);
      if (!t || !t.markPrice) return null;
      return safeUpstreamNum(t.markPrice);
    } catch {
      return null;
    }
  }
}
