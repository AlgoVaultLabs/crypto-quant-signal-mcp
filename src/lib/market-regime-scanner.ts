/**
 * market-regime-scanner.ts — SCAN-MARKET-REGIMES-W1-V2 CH2. The pure read engine behind
 * `scan_market_regimes`.
 *
 * It serves ONE generation of the bar-close regime snapshot (CH1's `regime_snapshots`): the newest
 * servable bar for (exchange, timeframe) per `latestServableGeneration` — the ONE definition of
 * "servable" the sampler, this tool and the CH3 canary all consume — then filters, orders and pages
 * the rows of that bar only. It never mixes bars: a page is always one `as_of`, and a generation that
 * advances between two pages shows up as a changed `as_of`, never as a silently blended result.
 *
 * WHAT IT DOES NOT DO. No quota, no billing, no refusal copy — the handler
 * (`src/tools/scan-market-regimes.ts`) owns those. No classification either: every regime label,
 * confidence and metric was computed by `computeMarketRegimeCore` at bar close and is served as
 * stored. The only value computed here is `underlying_session`, recomputed at scan time from the
 * stored `asset_class` with the same pure classifier `get_market_regime` uses (V2 §0 Q6), because a
 * session state stored at compute time is wrong for most of a 1d bar.
 *
 * COST. Without `rankBy` / `topN` / `minLiquidityUsd` a scan is two indexed DB reads and no upstream
 * request. A lens or a liquidity floor reuses `scan_trade_calls`' cached lens fetch and liquidity map
 * (`rank-metrics.ts`, `scan-shared.ts`), so it can cost upstream weight — the tool description must
 * not, and does not, claim otherwise.
 *
 * ALLOW-LIST. `toRegimeScanRow` copies each public field explicitly. The stored row also carries
 * `adx_slope`, `rule_version`, `computed_at` and `underlying_session_at_compute`; none of them reaches
 * the wire, and nothing here can emit a price, an `outcome_*`, reasoning, or a funding figure outside a
 * funding-lens echo.
 */
import {
  latestServableGeneration,
  readGenerationRows,
  type RegimeSnapshotRow,
  type ServableGeneration,
} from './regime-snapshots.js';
import { regimeFetchWindow } from './market-regime-core.js';
import { classifyUnderlyingSession } from './market-sessions.js';
import type { AssetClass } from './market-sessions-constants.js';
import { getRankedUniverse, type RankedAsset } from './rank-metrics.js';
import { resolveRankBy, type RankBy } from './rank-constants.js';
import { applyLiquidityFloor, applyRankEcho, type RankEchoFields } from './scan-shared.js';
import type { OiWindow, OiBasis } from './oi-snapshots.js';
import type { PromotedVenueId } from './capabilities.js';
import type { RegimeType } from '../types.js';
import type {
  REGIME_SCAN_ASSET_CLASSES,
  REGIME_SCAN_SORT_BY,
  REGIME_TIMEFRAMES,
} from './tool-param-schema.js';

export type RegimeScanTimeframe = (typeof REGIME_TIMEFRAMES)[number];
export type RegimeScanAssetClass = (typeof REGIME_SCAN_ASSET_CLASSES)[number];
export type RegimeScanSortBy = (typeof REGIME_SCAN_SORT_BY)[number];

/** `topN`'s default when a lens is named (V2 CH2 R1). Without a lens AND without `topN` there is no
 *  lens universe at all — the whole generation is the universe. */
export const REGIME_SCAN_TOP_N_DEFAULT = 100;
/** The page-size default. */
export const REGIME_SCAN_LIMIT_DEFAULT = 20;
/** The default staleness bound, in intervals (`REGIME_SNAPSHOT_STALE_FACTOR`). */
export const DEFAULT_REGIME_SNAPSHOT_STALE_FACTOR = 2;

/**
 * Stored `asset_class` values each `assetClass` filter admits. `tradfi` is every non-crypto class;
 * `equity` includes `KR_EQUITY`; `UNKNOWN` is admitted only by `all` (null = no filter).
 */
const TRADFI_CLASSES: readonly AssetClass[] = ['EQUITY', 'KR_EQUITY', 'COMMODITY', 'INDEX', 'FX', 'PREMARKET'];
const ASSET_CLASS_FILTER: Readonly<Record<RegimeScanAssetClass, ReadonlySet<string> | null>> = {
  all: null,
  crypto: new Set<AssetClass>(['CRYPTO']),
  tradfi: new Set<AssetClass>(TRADFI_CLASSES),
  equity: new Set<AssetClass>(['EQUITY', 'KR_EQUITY']),
  commodity: new Set<AssetClass>(['COMMODITY']),
  index: new Set<AssetClass>(['INDEX']),
  fx: new Set<AssetClass>(['FX']),
  premarket: new Set<AssetClass>(['PREMARKET']),
};

export interface ScanMarketRegimesParams {
  exchange: PromotedVenueId;
  timeframe: RegimeScanTimeframe;
  /** OR within the array. */
  regime?: readonly RegimeType[];
  minConfidence?: number;
  /** Rows with a KNOWN `regime_since` whose `regime_age_bars` ≤ n. NULL ages never match. */
  maxRegimeAgeBars?: number;
  assetClass?: RegimeScanAssetClass;
  minLiquidityUsd?: number;
  /** Restrict to these symbols; any not in the generation is listed in `not_found`. */
  coins?: readonly string[];
  /** Raw lens token (canonical or alias). The handler has already refused an unknown one. */
  rankBy?: string;
  topN?: number;
  oiChangeWindow?: OiWindow;
  oiBasis?: OiBasis;
  sortBy?: RegimeScanSortBy;
  limit?: number;
  offset?: number;
}

/** One public row — the allow-list. */
export interface RegimeScanRow extends RankEchoFields {
  coin: string;
  regime: string;
  confidence: number;
  trend_strength: string;
  adx: number | null;
  volatility_ratio: number;
  price_structure: string;
  asset_class: string;
  /** Recomputed at scan time from `asset_class` (V2 §0 Q6) — never the stored compute-time state. */
  underlying_session: string;
  /** ISO close of the first bar of the current regime run, or null until a transition was observed. */
  regime_since: string | null;
  /** Closed bars the current regime has held, the `as_of` bar included (1 = entered this bar). */
  regime_age_bars: number | null;
}

export interface RegimeScanGenerationMeta {
  universe: number;
  written: number;
  too_new: number;
  window_stale: number;
  /** written / (universe − too_new) × 100, one decimal. */
  coverage_pct: number;
}

export interface ScanMarketRegimesResult {
  exchange: string;
  timeframe: string;
  /** ISO close of the served bar — the generation key. */
  as_of: string;
  /** ISO instant the generation's producer run finished. */
  computed_at: string;
  generation: RegimeScanGenerationMeta;
  matched: number;
  returned: number;
  offset: number;
  /** Present ONLY when `coins` was passed. */
  not_found?: string[];
  regimes: RegimeScanRow[];
}

export type ScanMarketRegimesOutcome =
  | { status: 'ok'; result: ScanMarketRegimesResult }
  /** No servable generation, or the newest is older than the staleness bound. `as_of` null = none. */
  | { status: 'stale'; as_of: string | null; max_age_ms: number };

export interface RegimeScannerDeps {
  latestServableGeneration: (exchange: string, timeframe: string) => Promise<ServableGeneration | null>;
  readGenerationRows: (exchange: string, timeframe: string, barCloseMs: number) => Promise<RegimeSnapshotRow[]>;
  getRankedUniverse: typeof getRankedUniverse;
  applyLiquidityFloor: typeof applyLiquidityFloor;
  now: () => number;
}

export const DEFAULT_REGIME_SCANNER_DEPS: RegimeScannerDeps = {
  latestServableGeneration: (exchange, timeframe) => latestServableGeneration(exchange, timeframe),
  readGenerationRows,
  getRankedUniverse,
  applyLiquidityFloor,
  now: () => Date.now(),
};

/** `REGIME_SNAPSHOT_STALE_FACTOR`, default-deny parse: anything but a finite number ≥ 1 → default. */
export function regimeSnapshotStaleFactor(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REGIME_SNAPSHOT_STALE_FACTOR;
  if (raw == null || raw.trim() === '') return DEFAULT_REGIME_SNAPSHOT_STALE_FACTOR;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_REGIME_SNAPSHOT_STALE_FACTOR;
}

/** The candle interval of a regime timeframe — the SAME table the producer fetches with. */
export function regimeIntervalMs(timeframe: RegimeScanTimeframe): number {
  return regimeFetchWindow(timeframe, 0).intervalMs;
}

/** The session state for a stored asset class at `at` — `UNKNOWN` passes through, as in the sampler
 *  and `get_market_regime`. */
function sessionStateAt(assetClass: string, at: Date): string {
  return assetClass === 'UNKNOWN'
    ? 'UNKNOWN'
    : classifyUnderlyingSession({ assetClass: assetClass as AssetClass, at }).state;
}

/** Closed bars the regime has held at `asOfMs`, or null when its start is unknown. */
export function regimeAgeBars(row: Pick<RegimeSnapshotRow, 'regime_since_ms'>, asOfMs: number, intervalMs: number): number | null {
  if (row.regime_since_ms == null || !Number.isFinite(row.regime_since_ms)) return null;
  return Math.max(1, Math.round((asOfMs - row.regime_since_ms) / intervalMs) + 1);
}

/**
 * EXPORTED allow-list formatter. Every public field is copied by name — never a spread — and the lens
 * echo is added only through `applyRankEcho`, the one copy of `scan_trade_calls`' echo.
 */
export function toRegimeScanRow(
  row: RegimeSnapshotRow,
  asOfMs: number,
  intervalMs: number,
  nowMs: number,
  ranked?: RankedAsset,
): RegimeScanRow {
  const since = row.regime_since_ms;
  const out: RegimeScanRow = {
    coin: row.coin,
    regime: row.regime,
    confidence: row.confidence,
    trend_strength: row.trend_strength,
    adx: row.adx,
    volatility_ratio: row.volatility_ratio,
    price_structure: row.price_structure,
    asset_class: row.asset_class,
    underlying_session: sessionStateAt(row.asset_class, new Date(nowMs)),
    regime_since: since == null ? null : new Date(since).toISOString(),
    regime_age_bars: regimeAgeBars(row, asOfMs, intervalMs),
  };
  return applyRankEcho(out, ranked);
}

const normCoin = (c: string): string => c.trim().toUpperCase();

function byConfidence(a: RegimeScanRow, b: RegimeScanRow): number {
  return b.confidence - a.confidence || (a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : 0);
}

/** Most recent entry first (smallest age), NULL ages last; ties by confidence, then coin. */
function byRegimeAge(a: RegimeScanRow, b: RegimeScanRow): number {
  const an = a.regime_age_bars == null;
  const bn = b.regime_age_bars == null;
  if (an !== bn) return an ? 1 : -1;
  if (!an && !bn && a.regime_age_bars !== b.regime_age_bars) return (a.regime_age_bars as number) - (b.regime_age_bars as number);
  return byConfidence(a, b);
}

/**
 * Scan ONE servable generation. Returns `stale` (never throws for it) when there is no servable
 * generation or the newest one is older than `REGIME_SNAPSHOT_STALE_FACTOR` × interval.
 */
export async function scanMarketRegimes(
  params: ScanMarketRegimesParams,
  deps: RegimeScannerDeps = DEFAULT_REGIME_SCANNER_DEPS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScanMarketRegimesOutcome> {
  const { exchange, timeframe } = params;
  const intervalMs = regimeIntervalMs(timeframe);
  const maxAgeMs = regimeSnapshotStaleFactor(env) * intervalMs;
  const nowMs = deps.now();

  const gen = await deps.latestServableGeneration(exchange, timeframe);
  if (!gen) return { status: 'stale', as_of: null, max_age_ms: maxAgeMs };
  if (nowMs - gen.bar_close_ms > maxAgeMs) {
    return { status: 'stale', as_of: new Date(gen.bar_close_ms).toISOString(), max_age_ms: maxAgeMs };
  }

  const rows = await deps.readGenerationRows(exchange, timeframe, gen.bar_close_ms);
  const byCoin = new Map(rows.map((r) => [r.coin, r]));

  // ── Universe: generation ∩ coins ∩ lens top-N, then the liquidity floor ──
  let candidates: string[] = rows.map((r) => r.coin);
  let notFound: string[] | undefined;
  if (params.coins && params.coins.length > 0) {
    const asked = [...new Set(params.coins.map(normCoin).filter(Boolean))];
    notFound = asked.filter((c) => !byCoin.has(c));
    const keep = new Set(asked);
    candidates = candidates.filter((c) => keep.has(c));
  }

  const lensNamed = params.rankBy != null && String(params.rankBy).trim() !== '';
  const lens: RankBy | null = lensNamed
    ? (resolveRankBy(params.rankBy) ?? 'oi')
    : params.topN != null ? 'oi' : null;
  let rankMap: Map<string, { ranked: RankedAsset; index: number }> | undefined;
  if (lens) {
    const topN = params.topN ?? REGIME_SCAN_TOP_N_DEFAULT;
    const ranked = await deps.getRankedUniverse(exchange, lens, topN, timeframe, {
      oiChangeWindow: params.oiChangeWindow,
      oiBasis: params.oiBasis,
    });
    rankMap = new Map(ranked.map((r, index) => [r.coin, { ranked: r, index }]));
    candidates = candidates.filter((c) => rankMap!.has(c));
  }

  const minLiquidityUsd = params.minLiquidityUsd;
  if (minLiquidityUsd != null && minLiquidityUsd > 0 && candidates.length > 0) {
    candidates = await deps.applyLiquidityFloor(exchange, candidates, minLiquidityUsd);
  }

  // ── Row filters ──
  const regimeSet = params.regime && params.regime.length > 0 ? new Set<string>(params.regime) : null;
  const classSet = ASSET_CLASS_FILTER[params.assetClass ?? 'all'];
  const formatted: RegimeScanRow[] = [];
  for (const coin of candidates) {
    const row = byCoin.get(coin);
    if (!row) continue;
    if (regimeSet && !regimeSet.has(row.regime)) continue;
    if (params.minConfidence != null && !(row.confidence >= params.minConfidence)) continue;
    if (classSet && !classSet.has(row.asset_class)) continue;
    const ranked = lensNamed ? rankMap?.get(coin)?.ranked : undefined;
    const out = toRegimeScanRow(row, gen.bar_close_ms, intervalMs, nowMs, ranked);
    if (params.maxRegimeAgeBars != null && !(out.regime_age_bars != null && out.regime_age_bars <= params.maxRegimeAgeBars)) continue;
    formatted.push(out);
  }

  // ── Order + page ──
  const sortBy = params.sortBy ?? 'confidence';
  if (sortBy === 'rank' && rankMap) {
    const rm = rankMap;
    formatted.sort((a, b) => (rm.get(a.coin)?.index ?? Infinity) - (rm.get(b.coin)?.index ?? Infinity));
  } else if (sortBy === 'regime_age') {
    formatted.sort(byRegimeAge);
  } else {
    formatted.sort(byConfidence);
  }
  const offset = Math.max(0, Math.floor(params.offset ?? 0));
  const limit = Math.min(100, Math.max(1, Math.floor(params.limit ?? REGIME_SCAN_LIMIT_DEFAULT)));
  const page = formatted.slice(offset, offset + limit);

  return {
    status: 'ok',
    result: {
      exchange,
      timeframe,
      as_of: new Date(gen.bar_close_ms).toISOString(),
      computed_at: new Date(gen.finished_at).toISOString(),
      generation: {
        universe: gen.universe_n,
        written: gen.written_n,
        too_new: gen.too_new_n,
        window_stale: gen.window_stale_n,
        coverage_pct: Math.round(gen.coverage * 1000) / 10,
      },
      matched: formatted.length,
      returned: page.length,
      offset,
      ...(notFound !== undefined ? { not_found: notFound } : {}),
      regimes: page,
    },
  };
}
