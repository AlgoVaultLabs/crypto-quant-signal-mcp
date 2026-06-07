/**
 * edgeX adapter — implements ExchangeAdapter for edgeX L2 zk-rollup perp DEX.
 *
 * edgeX (`pro.edgex.exchange/api/v1/public/...`) uses a different shape from
 * the Binance-family CEXs/DEXes:
 *   - Numeric `contractId` ("10000001") is the primary key, NOT `symbol`.
 *   - Contract names follow `<COIN>USD` convention (NOT `<COIN>USDT`).
 *   - Response envelope: `{code:"SUCCESS", data:..., msg, errorParam,
 *     requestTime, responseTime, traceId}` — must drill into `data` to get
 *     the payload.
 *   - Kline interval values are SNAKE_UPPERCASE: `MINUTE_1 / HOUR_1 / DAY_1`.
 *   - `getKline` requires explicit `from`/`to` millisecond params (empty
 *     params return `dataList:[]`).
 *   - `getTicker` is an all-in-one bundle containing mark/index/oracle price,
 *     funding rate + next funding time, openInterest, and 24h price+volume.
 *
 * Funding cadence: 4 hours per probe (nextFundingTime - fundingTime =
 * 14,400,000 ms). Annualized = rate × 2190 (4h periods per year).
 *
 * Status: shadow (PILOT-ADAPTERS-W1 / C2, 2026-05-16). 292 contracts.
 */
import type {
  ExchangeAdapter,
  Candle,
  AssetContext,
  FundingData,
  DexType,
} from '../../types.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS, safeUpstreamNum } from './_upstream-fetch.js';

const BASE_URL = 'https://pro.edgex.exchange';
const MAX_RETRIES = 1;

// Map AlgoVault canonical intervals to edgeX klineType values
const INTERVAL_MAP: Record<string, string> = {
  '1m':  'MINUTE_1',
  '3m':  'MINUTE_3',
  '5m':  'MINUTE_5',
  '15m': 'MINUTE_15',
  '30m': 'MINUTE_30',
  '1h':  'HOUR_1',
  '2h':  'HOUR_2',
  '4h':  'HOUR_4',
  '8h':  'HOUR_8',
  '12h': 'HOUR_12',
  '1d':  'DAY_1',
};

// Bar-length lookup (ms) for kline `from` window calculation when caller
// passes startTime in ms.
const BAR_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
};

// ── contractName ↔ contractId lookup (lazy-init from getMetaData) ────────

interface EdgeXContract {
  contractId: string;
  contractName: string;
}

interface EdgeXEnvelope<T> {
  code: string;
  data: T;
  msg: string | null;
  errorParam: unknown;
}

let contractCache: { byCoin: Map<string, string>; byId: Map<string, string>; fetchedAt: number } | null = null;
const META_TTL_MS = 60 * 60_000; // 1h — contract listings change rarely

async function ensureContractMap(): Promise<{ byCoin: Map<string, string>; byId: Map<string, string> }> {
  if (contractCache && Date.now() - contractCache.fetchedAt < META_TTL_MS) {
    return contractCache;
  }
  const raw = await edgexGet<EdgeXEnvelope<{ contractList: EdgeXContract[] }>>('/api/v1/public/meta/getMetaData');
  const byCoin = new Map<string, string>();
  const byId = new Map<string, string>();
  for (const c of raw.data.contractList || []) {
    // contractName is e.g. "BTCUSD" → coin canonical "BTC"
    const coin = c.contractName.replace(/USD$/, '');
    byCoin.set(coin.toUpperCase(), c.contractId);
    byId.set(c.contractId, coin.toUpperCase());
  }
  contractCache = { byCoin, byId, fetchedAt: Date.now() };
  return contractCache;
}

export async function toEdgeXContractId(coin: string): Promise<string | null> {
  const { byCoin } = await ensureContractMap();
  return byCoin.get(coin.toUpperCase()) ?? null;
}

export async function fromEdgeXContractId(contractId: string): Promise<string> {
  const { byId } = await ensureContractMap();
  return byId.get(contractId) ?? contractId;
}

/** Test-seam: clear the contract cache so unit tests can re-init deterministically. */
export function _resetEdgeXCacheForTest(): void {
  contractCache = null;
}

// ── HTTP client ──────────────────────────────────────────────────────────

async function edgexGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build unchanged; fetch/retry/ban via upstreamFetch.
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  return upstreamFetch<T>({ ...VENUE_FETCH_CONFIGS.EDGEX, transientRetries: retries }, { url: url.toString() });
}

// ── Response shapes ──────────────────────────────────────────────────────

interface EdgeXKline {
  klineId: string;
  klineTime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  size: string;   // base volume
  value: string;  // quote volume
  trades: string;
}

interface EdgeXTicker {
  contractId: string;
  contractName: string;
  lastPrice: string;
  indexPrice: string;
  oraclePrice: string;
  markPrice: string;
  openInterest: string;
  fundingRate: string;
  fundingTime: string;
  nextFundingTime: string;
  size: string;
  value: string;
  open: string;
  high: string;
  low: string;
  close: string;
}

interface EdgeXFundingHistEntry {
  contractId: string;
  fundingTime: string;
  fundingRate: string;
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class EdgeXAdapter implements ExchangeAdapter {
  getName(): string {
    return 'edgeX';
  }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const contractId = await toEdgeXContractId(coin);
    if (!contractId) return [];
    const klineType = INTERVAL_MAP[interval] || 'HOUR_1';
    const barMs = BAR_MS[interval] || 3_600_000;

    // edgeX getKline requires explicit from + to (ms). startTime is the
    // floor of the window; cap `to` at now to avoid future-bar empty.
    const from = startTime;
    const to = Math.max(from + barMs, Date.now());

    const raw = await edgexGet<EdgeXEnvelope<{ dataList: EdgeXKline[] }>>('/api/v1/public/quote/getKline', {
      contractId,
      priceType: 'LAST_PRICE',
      klineType,
      from,
      to,
      size: 200,
    });

    // SV-04: default-deny — drop any candle with a non-finite OHLCV field.
    return (raw.data?.dataList || []).flatMap(c => {
      const open = safeUpstreamNum(c.open);
      const high = safeUpstreamNum(c.high);
      const low = safeUpstreamNum(c.low);
      const close = safeUpstreamNum(c.close);
      const volume = safeUpstreamNum(c.size);
      if (open === null || high === null || low === null || close === null || volume === null) return [];
      return [{ time: parseInt(c.klineTime, 10), open, high, low, close, volume }];
    });
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const contractId = await toEdgeXContractId(coin);
    if (!contractId) {
      throw new Error(`edgeX: unknown contract for coin "${coin}"`);
    }

    const raw = await edgexGet<EdgeXEnvelope<EdgeXTicker[]>>('/api/v1/public/quote/getTicker', { contractId });
    const t = raw.data?.[0];
    if (!t) {
      throw new Error(`edgeX: empty ticker payload for ${coin} (contractId=${contractId})`);
    }

    // edgeX funding cadence: 4 hours per probe (nextFundingTime - fundingTime
    // = 14_400_000 ms). Annualized = rate × 2190 (4h periods per year).
    // SV-04: default-deny — invalid markPrice throws (3-tier fallback fires);
    // non-price fields fall back to a safe neutral 0 (never propagate garbage).
    const fundingRaw = safeUpstreamNum(t.fundingRate) ?? 0;
    const markPx = safeUpstreamNum(t.markPrice);
    if (markPx === null) throw new Error('edgeX getAssetContext: invalid markPrice');
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 2190,
      openInterest: safeUpstreamNum(t.openInterest) ?? 0,
      prevDayPx: safeUpstreamNum(t.open) ?? 0,
      volume24h: safeUpstreamNum(t.value) ?? 0,
      oraclePx: safeUpstreamNum(t.oraclePrice) ?? markPx,
      markPx,
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // edgeX has no batch funding-rate endpoint; build by iterating contracts.
    // For shadow-mode operation this is acceptable (low call volume); promote-
    // time consideration: cache + invalidate per 4h funding tick.
    try {
      const { byCoin } = await ensureContractMap();
      const fundings: FundingData[] = [];
      for (const [coin, contractId] of byCoin) {
        try {
          const raw = await edgexGet<EdgeXEnvelope<EdgeXTicker[]>>('/api/v1/public/quote/getTicker', { contractId });
          const t = raw.data?.[0];
          if (!t) continue;
          fundings.push({
            coin,
            venues: [{
              venue: 'edgeXPerp',
              fundingRate: parseFloat(t.fundingRate || '0'),
              nextFundingTime: parseInt(t.nextFundingTime || '0', 10),
            }],
          });
        } catch {
          // Per-contract failure shouldn't kill the whole fan-out
          continue;
        }
      }
      return fundings;
    } catch {
      return [];
    }
  }

  async getFundingHistory(coin: string, startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    try {
      const contractId = await toEdgeXContractId(coin);
      if (!contractId) return [];
      const raw = await edgexGet<EdgeXEnvelope<EdgeXFundingHistEntry[]>>('/api/v1/public/funding/getLatestFundingRate', { contractId });
      const records = (raw.data || [])
        .filter(r => r.fundingRate != null && !isNaN(parseFloat(r.fundingRate)))
        .map(r => ({
          time: parseInt(r.fundingTime, 10),
          fundingRate: parseFloat(r.fundingRate),
        }));
      // Filter to >= startTime since the endpoint returns latest only
      return records.filter(r => r.time >= startTime);
    } catch {
      return [];
    }
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const contractId = await toEdgeXContractId(coin);
      if (!contractId) return null;
      const raw = await edgexGet<EdgeXEnvelope<EdgeXTicker[]>>('/api/v1/public/quote/getTicker', { contractId });
      const t = raw.data?.[0];
      if (!t) return null;
      return parseFloat(t.markPrice);
    } catch {
      return null;
    }
  }
}
