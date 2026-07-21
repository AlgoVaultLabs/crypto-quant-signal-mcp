/**
 * oi-sources.ts — SCAN-RANKBY-W3 CH2
 *
 * Per-venue REAL open-interest fetchers for the oi_snapshots sampler + backfill.
 * Kept apart from oi-snapshots.ts (the DB/delta layer) — this is the HTTP layer.
 *
 * Venue OI sourcing (live-probed 2026-06-27):
 *  - HL / BYBIT / OKX / BITGET: `fetchVenueUniverse().notionalOI_usd` IS real OI
 *    (oi × price). Reused directly — no extra calls.
 *  - BINANCE: `notionalOI_usd` is a VOLUME proxy (no bulk OI endpoint), so it is
 *    NOT usable as OI. Real OI comes per-symbol from `/futures/data/openInterestHist`
 *    `sumOpenInterestValue` (native USD). Off the request path (hourly sampler) so
 *    the per-symbol fan-out over the pool is fine.
 *
 * Backfill history (shrink the one-time 24h warming):
 *  - BINANCE: openInterestHist period=1h → sumOpenInterestValue (USD, direct).
 *  - BYBIT: open-interest intervalTime=1h gives OI in CONTRACTS → × hourly close
 *    (real price, via the verdict-engine adapter) = USD, consistent with the
 *    USD sampler. OKX(per-CCY granularity)/BITGET(no history)/HL(none) warm forward.
 */

import type { ExchangeId } from '../types.js';
import { fetchVenueUniverse, OI_PROXY_VENUES, type ExchangeAsset } from './exchange-universe.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS } from './adapters/_upstream-fetch.js';
import { getAdapter } from './exchange-adapter.js';
import { bucketHour } from './oi-snapshots.js';

export interface CurrentOi {
  coin: string;
  /** USD notional open interest. */
  oi: number;
  /** SCAN-RANKBY-REFINEMENTS-W1 CH3: base-coin-unit OI (price-independent). undefined
   *  when the venue doesn't expose it for this coin (→ NULL contracts_oi, warms forward). */
  contracts?: number;
}

/** Concurrency-limited map (no external dep) — for the per-symbol Binance fan-out. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

/** Binance per-symbol OI history → [{ ts, oi(USD), contracts(base) }] via
 *  sumOpenInterestValue (USD) + sumOpenInterest (base-coin; CH3). */
async function binanceOiHistUsd(
  coin: string,
  period: string,
  limit: number,
): Promise<Array<{ ts: number; oi: number; contracts: number }>> {
  const url =
    `https://fapi.binance.com/futures/data/openInterestHist?symbol=${coin}USDT&period=${period}&limit=${limit}`;
  const data = await upstreamFetch<Array<{ sumOpenInterestValue?: string; sumOpenInterest?: string; timestamp?: number }>>(
    VENUE_FETCH_CONFIGS.BINANCE,
    { url, method: 'GET', cls: 'batch' },
  );
  if (!Array.isArray(data)) return [];
  return data
    .map((d) => ({
      ts: Number(d.timestamp),
      oi: parseFloat(d.sumOpenInterestValue ?? 'NaN'),
      contracts: parseFloat(d.sumOpenInterest ?? 'NaN'), // CH3: base-coin OI
    }))
    .filter((d) => Number.isFinite(d.ts) && Number.isFinite(d.oi) && d.oi > 0);
}

/**
 * Current USD-notional OI for the top-`poolSize` perps on `exchange`.
 * 4 venues read from the universe directly; Binance fans out per-symbol.
 *
 * OPS-STRUCTURAL-FEATURE-ACCRUAL-W1: `universeOverride` is an OPTIONAL TRAILING param (TS
 * bivariance — no signature cascade for existing callers) so a caller that ALREADY holds this
 * venue's universe passes it instead of forcing a second fetch. The sampler needs the universe
 * anyway for the structural fields, and re-fetching here was BOTH a doubled upstream call and a
 * correctness bug: two fetches of a LIVE-REORDERING ranking return two different top-N slices, so
 * the union of "OI coins" and "pool coins" could exceed the pool and a same-bucket re-run inserted
 * genuinely-new rows (measured 2026-07-21: ASTER + MEXC each landed a 61st row for one bucket).
 * One snapshot in, one pool out, deterministic.
 */
export async function fetchCurrentOiUsd(
  exchange: ExchangeId,
  poolSize: number,
  universeOverride?: ExchangeAsset[],
): Promise<CurrentOi[]> {
  // OPS-SCAN-UNIVERSE-EXPAND-W1: proxy venues (Aster/BingX) expose no real OI — their
  // fetchVenueUniverse `notionalOI_usd` is a 24h-VOLUME proxy, so NEVER sample them as OI (it would
  // pollute the oi_change lens + snapshots with volume). Binance is a proxy too but has its own
  // openInterestHist real-OI path below, so it is exempt from the skip.
  if (OI_PROXY_VENUES.has(exchange) && exchange !== 'BINANCE') return [];
  const universe = universeOverride ?? (await fetchVenueUniverse(exchange));
  const pool = universe.slice(0, poolSize);
  if (exchange === 'BINANCE') {
    const results = await mapLimit(pool, 6, async (a) => {
      try {
        const hist = await binanceOiHistUsd(a.coin, '5m', 1);
        const last = hist.length ? hist[hist.length - 1] : null;
        const oi = last ? last.oi : NaN;
        // CH3: base-coin OI from sumOpenInterest (omitted if absent → NULL contracts_oi).
        const contracts = last && Number.isFinite(last.contracts) && last.contracts > 0 ? last.contracts : undefined;
        return Number.isFinite(oi) && oi > 0
          ? { coin: a.coin, oi, ...(contracts !== undefined ? { contracts } : {}) }
          : null;
      } catch {
        return null;
      }
    });
    return results.filter((x): x is CurrentOi => x !== null);
  }
  // CH3: the 4 universe-OI venues carry base-coin OI on `baseOI` (HL/Bybit/OKX/Bitget).
  return pool
    .filter((a) => Number.isFinite(a.notionalOI_usd) && a.notionalOI_usd > 0)
    .map((a) => ({
      coin: a.coin,
      oi: a.notionalOI_usd,
      ...(Number.isFinite(a.baseOI) && (a.baseOI as number) > 0 ? { contracts: a.baseOI } : {}),
    }));
}

/**
 * ~`hours` of hourly USD OI history for (exchange, coin) — backfill only.
 * Returns null for venues without clean USD-comparable history (warm forward).
 */
export async function fetchOiHistoryUsd(
  exchange: ExchangeId,
  coin: string,
  hours: number,
): Promise<Array<{ ts: number; oi: number }> | null> {
  if (exchange === 'BINANCE') {
    const hist = await binanceOiHistUsd(coin, '1h', hours);
    // Backfill is notional-only ({ts,oi}); contracts WARM FORWARD (not backfilled — CH3).
    return hist.length ? hist.map((h) => ({ ts: h.ts, oi: h.oi })) : null;
  }
  if (exchange === 'BYBIT') {
    const resp = await upstreamFetch<{ result?: { list?: Array<{ openInterest?: string; timestamp?: string }> } }>(
      VENUE_FETCH_CONFIGS.BYBIT,
      {
        url: `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${coin}USDT&intervalTime=1h&limit=${hours}`,
        method: 'GET',
        cls: 'batch',
      },
    );
    const list = resp?.result?.list ?? [];
    if (!list.length) return null;
    // OI is in contracts → multiply by the real hourly close (price) to get USD.
    const startTime = Date.now() - (hours + 2) * 60 * 60 * 1000;
    const candles = await getAdapter('BYBIT').getCandles(coin, '1h', startTime);
    const closeByBucket = new Map<number, number>();
    for (const c of candles) closeByBucket.set(bucketHour(c.time), c.close);
    const out = list
      .map((r) => {
        const ts = Number(r.timestamp);
        const contracts = parseFloat(r.openInterest ?? 'NaN');
        const close = closeByBucket.get(bucketHour(ts));
        return close && Number.isFinite(contracts) ? { ts, oi: contracts * close } : null;
      })
      .filter((x): x is { ts: number; oi: number } => x !== null && x.oi > 0);
    return out.length ? out : null;
  }
  return null; // OKX / BITGET / HL → warm forward
}
