/**
 * venue-market-state.ts — DECISION-CALL-V1-W1 R2.
 *
 * ONE home for the per-venue market facts every venue-aware reader shares:
 *
 *   • the venue UNIVERSE (`fetchVenueUniverse` rows) behind a single-flight 60 s cache — read by
 *     `scan_funding_arb`'s per-leg liquidity gate AND the scan-shared `minLiquidityUsd` floor
 *     (`scan_trade_calls`, `scan_market_regimes`);
 *   • the 30 s predicted-funding cache per fetch adapter and the MERGED cross-venue funding
 *     snapshot built from it;
 *   • the funding-row rule (`normalizeVenueFunding`): venue-string → venue, the contract's interval
 *     or the declared fallback, and the hourly rate the arb ranks on.
 *
 * WHY A MODULE. Before this wave the universe lived in TWO private 60 s caches (the arb's
 * `getVenueLiquidity` and scan-shared's `getVenueLiquidityUsd`, each its own fetch), and the funding
 * snapshot + interval rule lived inside `scan-funding-arb.ts`, where no second reader could reach
 * them. A third copy for the decision call (W2) would drift, so the state is extracted VERBATIM —
 * `tests/unit/scan-funding-arb-golden.test.ts` was recorded from the pre-extraction code and pins
 * the arb and the floor byte-identical through the move.
 *
 * NO CYCLE. Imports nothing from `src/tools/**` or `scan-shared.ts` — they read this, never the
 * reverse.
 */
import { getAdapter } from './exchange-adapter.js';
import { fetchVenueUniverse, type ExchangeAsset } from './exchange-universe.js';
import { coalescedCache } from './coalesced-cache.js';
import { annualizeFunding } from './rank-constants.js';
import { FUNDING_VENUE_META, FUNDING_ARB_FETCH_ADAPTERS } from './funding-venues.js';
import type { ExchangeId, FundingData } from '../types.js';

// ── Venue universe ──────────────────────────────────────────────────────────────────────────────

/** A venue's universe read. `failed` ⇔ the read threw OR came back empty — both leave the readers
 *  nothing to judge a coin by, so both default-DENY downstream (unknown coin ⇒ liquidity 0). */
export interface VenueUniverseState {
  readonly rows: readonly ExchangeAsset[];
  readonly failed: boolean;
}

// 60 s TTL, unchanged from the two caches this replaces. `negativeTtlMs: 0` and a loader that never
// throws: a failed read is a VALUE (`failed: true`) cached for the full TTL, exactly as both old
// caches cached their empty map — so a down venue is re-probed once a minute, not on every call.
const UNIVERSE_TTL_MS = 60_000;

const universeCache = coalescedCache<VenueUniverseState>({
  load: async (exchange) => {
    try {
      const rows = await fetchVenueUniverse(exchange as ExchangeId);
      return rows.length > 0 ? { rows, failed: false } : { rows: [], failed: true };
    } catch (err) {
      console.debug(
        `[venue-market-state] universe fetch failed for ${exchange} — liquidity reads deny all:`,
        err instanceof Error ? err.message : err,
      );
      return { rows: [], failed: true };
    }
  },
  ttlMs: UNIVERSE_TTL_MS,
  negativeTtlMs: 0,
});

/** The ONE cached universe read for `exchange` (single-flight: concurrent cold readers share a fetch). */
export async function getVenueUniverseState(exchange: ExchangeId): Promise<VenueUniverseState> {
  return universeCache.get(exchange);
}

// ── Predicted funding ───────────────────────────────────────────────────────────────────────────

/** One funding row as an adapter emits it, read-only to every consumer of the shared snapshot. */
export type VenueFundingRow = Readonly<FundingData['venues'][number]>;

// HL updates predicted funding on the minute, the rest slower; 30 s is the arb's historical TTL.
// A failed fetch is NOT cached (no stale, no fallback ⇒ the next call retries) — today's semantics,
// now single-flight per adapter.
const PREDICTED_FUNDINGS_TTL_MS = 30_000;

const predictedFundingsCache = coalescedCache<FundingData[]>({
  load: (exchangeId) => getAdapter(exchangeId as ExchangeId).getPredictedFundings(),
  ttlMs: PREDICTED_FUNDINGS_TTL_MS,
  negativeTtlMs: 0,
});

/** The merged cross-venue funding snapshot. */
export interface MergedFundingSnapshot {
  /** coin → its funding rows across every fetched venue, in fetch-adapter order. */
  readonly byCoin: ReadonlyMap<string, readonly VenueFundingRow[]>;
  /** Every FUNDING_VENUE_META venue whose fetch adapter threw or returned zero rows this cycle. */
  readonly failedVenues: ReadonlySet<ExchangeId>;
}

/**
 * Fetch every non-retired `FUNDING_ARB_FETCH_ADAPTERS` feed (fail-soft PER adapter — a down feed is
 * a failed venue, never a crash) and merge by coin. A venue-string already merged for a coin keeps
 * its first row.
 */
export async function getMergedFundingSnapshot(retired: ReadonlySet<string>): Promise<MergedFundingSnapshot> {
  const fetchAdapters = FUNDING_ARB_FETCH_ADAPTERS.filter((v) => !retired.has(v));
  const feeds = await Promise.all(
    fetchAdapters.map((v) => predictedFundingsCache.get(v).catch(() => [] as FundingData[])),
  );

  const byCoin = new Map<string, VenueFundingRow[]>();
  const failedAdapters = new Set<ExchangeId>();
  feeds.forEach((feed, i) => {
    // An adapter that turns its errors into `[]` (Gate, KuCoin) is indistinguishable from one that
    // threw — an empty feed is a failed feed.
    if (feed.length === 0) failedAdapters.add(fetchAdapters[i]);
    for (const entry of feed) {
      const merged = byCoin.get(entry.coin) ?? [];
      for (const ve of entry.venues) {
        if (!merged.some((m) => m.venue === ve.venue)) merged.push(ve);
      }
      byCoin.set(entry.coin, merged);
    }
  });

  const failedVenues = new Set<ExchangeId>();
  for (const m of Object.values(FUNDING_VENUE_META)) {
    if (failedAdapters.has(m.fetchedVia)) failedVenues.add(m.exchangeId);
  }
  return { byCoin, failedVenues };
}

// ── The funding-row rule ────────────────────────────────────────────────────────────────────────

const HOURS_PER_YEAR = 8760;

/** A funding row resolved against the venue SoT. */
export interface NormalizedVenueFunding {
  venue: string;
  exchangeId: ExchangeId;
  rate: number;
  intervalHours: number;
  /** `contract` — the row published its own period; `declared` — FUNDING_VENUE_META's fallback. */
  intervalBasis: 'contract' | 'declared';
  nextFundingTime: number;
  /** `annualizeFunding(rate, intervalHours) / 8760` — the arb's exact arithmetic (= rate / interval). */
  hourlyRate: number;
}

/**
 * Resolve one funding row, or `null` when it must not be used:
 *   • a venue-string outside FUNDING_VENUE_META (never guess its interval → no false spread);
 *   • a NaN rate;
 *   • an `intervalHours` the row PUBLISHED but that is not a positive finite number — a venue that
 *     answered with a broken period has forfeited the right to a default (OPS-AUDIT-REMEDIATION-HIGH-W1
 *     SEC-06). ABSENT → the venue's declared cadence.
 */
export function normalizeVenueFunding(row: VenueFundingRow): NormalizedVenueFunding | null {
  const meta = FUNDING_VENUE_META[row.venue];
  if (!meta) return null;
  if (isNaN(row.fundingRate)) return null;
  const rowInterval = row.intervalHours;
  if (rowInterval !== undefined && !(Number.isFinite(rowInterval) && rowInterval > 0)) return null;
  const intervalHours = rowInterval ?? meta.intervalHours;
  const annualized = annualizeFunding(row.fundingRate, intervalHours);
  if (annualized === null) return null;
  return {
    venue: row.venue,
    exchangeId: meta.exchangeId,
    rate: row.fundingRate,
    intervalHours,
    intervalBasis: rowInterval === undefined ? 'declared' : 'contract',
    nextFundingTime: row.nextFundingTime,
    hourlyRate: annualized / HOURS_PER_YEAR,
  };
}

// ── Test seams ──────────────────────────────────────────────────────────────────────────────────

/** Reset every cache this module owns (tests only). */
export function _resetVenueMarketStateCaches(): void {
  universeCache._clear();
  predictedFundingsCache._clear();
}

/** Reset only the predicted-funding cache (tests that vary fundings while keeping the universe). */
export function _resetPredictedFundingsCacheForTest(): void {
  predictedFundingsCache._clear();
}

/** Read-only inspector: which keys currently hold a value (tests only). */
export function _getVenueMarketStateSizesForTest(): { universeVenues: ExchangeId[]; fundingAdapters: ExchangeId[] } {
  const held = (c: { _getState(k: string): { value?: unknown } | null }, keys: readonly string[]): ExchangeId[] =>
    keys.filter((k) => c._getState(k)?.value !== undefined) as ExchangeId[];
  const venues = [...new Set(Object.values(FUNDING_VENUE_META).map((m) => m.exchangeId))];
  return {
    universeVenues: held(universeCache, [...new Set<string>([...venues, ...FUNDING_ARB_FETCH_ADAPTERS])]),
    fundingAdapters: held(predictedFundingsCache, FUNDING_ARB_FETCH_ADAPTERS),
  };
}
