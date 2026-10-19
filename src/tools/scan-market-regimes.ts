// ── scan_market_regimes tool wrapper (SCAN-MARKET-REGIMES-W1-V2 CH2) ──
//
// Thin refusal + quota + envelope layer over the pure read engine
// (`src/lib/market-regime-scanner.ts`), mirroring `scan-trade-calls.ts`: the pipeline row stays
// minimal and this unit is importable by tests without index.ts's bootstrap.
//
// ORDER IS THE CONTRACT (V2 CH2 R2). Every refusal before the scan is UNBILLED:
//   1. invalid lens / `sortBy:"rank"` without `rankBy`  → invalid_parameter
//   2. a wound-down venue                                → assertVenueNotRetired (named throw, as the
//                                                          other venue tools do)
//   3. a venue outside `sampledRegimeVenues()`           → venue_not_sampled {sampled_venues}
//   4. a pair whose producer last recorded WINDOW_STALE  → timeframe_unserved — DERIVED from the run
//                                                          record, never a hand-kept list, so a pair
//                                                          starts serving the tick its adapter heals
//   5. the entry quota check                             → the SAME wall `scan_trade_calls` renders
//                                                          (`buildScanQuotaWall`, one builder)
//   6. no servable generation, or one older than the     → snapshot_stale — a serving-path guard
//      staleness bound                                     REFUSES, it never throws
//   7. scan → trackCall(license, max(1, returned)) → `_algovault`
//
// BILLING. One unit per RETURNED row (`Math.max(1, …)` so an empty page still costs the call it
// consumed). Coins that matched nothing are free — that is the whole point of a screener — and
// `not_found` symbols are never billed.
//
// NO INTERNAL IDENTIFIERS on the wire. `timeframe_unserved` names the served alternatives the run
// record proves, and nothing about why or which wave owns the fix. It never points at
// `get_market_regime` for the unserved pair, because that pair's live window is the stale path.

import {
  scanMarketRegimes,
  DEFAULT_REGIME_SCANNER_DEPS,
  type RegimeScannerDeps,
  type ScanMarketRegimesParams,
  type ScanMarketRegimesResult,
} from '../lib/market-regime-scanner.js';
import {
  sampledRegimeVenues,
  latestRunDisposition,
  latestServableGeneration,
  REGIME_SNAPSHOT_TIMEFRAMES,
  type RegimeSnapshotRunRecord,
  type ServableGeneration,
} from '../lib/regime-snapshots.js';
import { checkQuota, trackCall, getRequestSessionId } from '../lib/license.js';
import { assertVenueNotRetired } from '../lib/venue-store.js';
import { referralCodeForKey } from '../lib/referral-store.js';
import { buildScanQuotaWall, buildScanQuotaState, type ScanQuotaWallBody } from '../lib/scan-shared.js';
import { resolveRankBy, rankByTokens } from '../lib/rank-constants.js';
import { withAuthState } from '../lib/tier-warning.js';
import { PKG_VERSION } from '../lib/pkg-version.js';
import { z } from 'zod';
import {
  PUBLIC_VENUE_ENUM,
  REGIME_TIMEFRAMES,
  REGIME_LABELS,
  REGIME_SCAN_ASSET_CLASSES,
  REGIME_SCAN_SORT_BY,
  OI_CHANGE_WINDOWS,
  OI_BASES,
  SCAN_MARKET_REGIMES_PARAM_DECL,
} from '../lib/tool-param-schema.js';
import {
  SCAN_MARKET_REGIMES_DESCRIPTION,
  PARAM_DESC_REGIME_SCAN_EXCHANGE,
  PARAM_DESC_REGIME_SCAN_TIMEFRAME,
  PARAM_DESC_REGIME_SCAN_REGIME,
  PARAM_DESC_REGIME_SCAN_MIN_CONFIDENCE,
  PARAM_DESC_REGIME_SCAN_MAX_REGIME_AGE_BARS,
  PARAM_DESC_REGIME_SCAN_ASSET_CLASS,
  PARAM_DESC_REGIME_SCAN_COINS,
  PARAM_DESC_REGIME_SCAN_RANK_BY,
  PARAM_DESC_REGIME_SCAN_TOP_N,
  PARAM_DESC_REGIME_SCAN_SORT_BY,
  PARAM_DESC_REGIME_SCAN_LIMIT,
  PARAM_DESC_REGIME_SCAN_OFFSET,
  PARAM_DESC_SCAN_MIN_LIQUIDITY_USD,
  PARAM_DESC_SCAN_OI_CHANGE_WINDOW,
  PARAM_DESC_SCAN_OI_BASIS,
} from '../tool-descriptions.js';
import type { PromotedVenueId } from '../lib/capabilities.js';
import type { LicenseInfo, QuotaState } from '../types.js';

export const SCAN_MARKET_REGIMES_TOOL = 'scan_market_regimes' as const;

export { SCAN_MARKET_REGIMES_DESCRIPTION };

const E = SCAN_MARKET_REGIMES_PARAM_DECL.enums;

/**
 * Zod raw shape for `server.tool`. Every enum and default projects from `SCAN_MARKET_REGIMES_PARAM_DECL`
 * (tool-param-schema.ts), the ONE declaration the release wave moves into the public docs maps. The
 * enum ARRAYS are named imports — the very arrays that declaration references, identity-pinned by
 * tests/scan-market-regimes.test.ts — because the REL-3 relational gate resolves each `z.enum(X)`
 * through the file's named imports; the defaults read through the declaration.
 * `rankBy` is a bounded raw string, as on `scan_trade_calls` (SEC-45): `resolveRankBy` owns validity, so
 * an alias reaches the handler verbatim and an unknown token is refused there, unbilled.
 */
export const SCAN_MARKET_REGIMES_SCHEMA = {
  exchange: z.enum(PUBLIC_VENUE_ENUM).default(E.exchange.default).describe(PARAM_DESC_REGIME_SCAN_EXCHANGE),
  timeframe: z.enum(REGIME_TIMEFRAMES).default(E.timeframe.default).describe(PARAM_DESC_REGIME_SCAN_TIMEFRAME),
  regime: z.array(z.enum(REGIME_LABELS)).min(1).max(4).optional().describe(PARAM_DESC_REGIME_SCAN_REGIME),
  minConfidence: z.number().min(0).max(100).optional().describe(PARAM_DESC_REGIME_SCAN_MIN_CONFIDENCE),
  maxRegimeAgeBars: z.number().int().min(1).max(500).optional().describe(PARAM_DESC_REGIME_SCAN_MAX_REGIME_AGE_BARS),
  assetClass: z.enum(REGIME_SCAN_ASSET_CLASSES).default(E.assetClass.default).describe(PARAM_DESC_REGIME_SCAN_ASSET_CLASS),
  minLiquidityUsd: z.number().min(0).optional().describe(PARAM_DESC_SCAN_MIN_LIQUIDITY_USD),
  coins: z.array(z.string().min(1).max(32)).min(1).max(200).optional().describe(PARAM_DESC_REGIME_SCAN_COINS),
  rankBy: z.string().max(32).optional().describe(PARAM_DESC_REGIME_SCAN_RANK_BY),
  topN: z.number().int().min(1).max(1000).optional().describe(PARAM_DESC_REGIME_SCAN_TOP_N),
  oiChangeWindow: z.enum(OI_CHANGE_WINDOWS).default(E.oiChangeWindow.default).describe(PARAM_DESC_SCAN_OI_CHANGE_WINDOW),
  oiBasis: z.enum(OI_BASES).default(E.oiBasis.default).describe(PARAM_DESC_SCAN_OI_BASIS),
  sortBy: z.enum(REGIME_SCAN_SORT_BY).default(E.sortBy.default).describe(PARAM_DESC_REGIME_SCAN_SORT_BY),
  limit: z.number().int().min(1).max(100).default(20).describe(PARAM_DESC_REGIME_SCAN_LIMIT),
  offset: z.number().int().min(0).default(0).describe(PARAM_DESC_REGIME_SCAN_OFFSET),
};

/** The envelope identity every response carries (stamped by `withAuthState`). */
interface RegimeScanIdentity {
  tool: typeof SCAN_MARKET_REGIMES_TOOL;
  version: string;
  session_id: string | null;
}

export interface ScanMarketRegimesMeta extends RegimeScanIdentity {
  /** Post-charge meter, the shared `QuotaState` (daily pair + `binding` when a daily meter exists). */
  quota: QuotaState;
}

export interface ScanMarketRegimesResponse extends ScanMarketRegimesResult {
  _algovault: ScanMarketRegimesMeta;
}

export type ScanMarketRegimesRefusal =
  | { error: 'invalid_parameter'; code: 'invalid_parameter'; param: 'rankBy' | 'sortBy'; message: string; valid_values: string[]; suggested_action: string; _algovault: RegimeScanIdentity }
  | { error: 'venue_not_sampled'; code: 'venue_not_sampled'; exchange: string; message: string; sampled_venues: string[]; suggested_action: string; _algovault: RegimeScanIdentity }
  | { error: 'timeframe_unserved'; code: 'timeframe_unserved'; exchange: string; timeframe: string; message: string; served_timeframes_on_venue: string[]; venues_serving_timeframe: string[]; suggested_action: string; _algovault: RegimeScanIdentity }
  | (ScanQuotaWallBody & { _algovault: RegimeScanIdentity })
  | { error: 'snapshot_stale'; code: 'snapshot_stale'; exchange: string; timeframe: string; as_of: string | null; message: string; suggested_action: string; _algovault: RegimeScanIdentity };

/** The handler's outcome. `status` is the HTTP-equivalent status of a refusal, for the pipeline. */
export type ScanMarketRegimesOutcome =
  | { kind: 'ok'; response: ScanMarketRegimesResponse }
  | { kind: 'refused'; payload: ScanMarketRegimesRefusal; status: number };

/** What the handler reads besides the engine. A seam so tests run with no DB. */
export interface RegimeScanHandlerDeps {
  sampledRegimeVenues: () => Promise<PromotedVenueId[]>;
  latestRunDisposition: (exchange: string, timeframe: string) => Promise<RegimeSnapshotRunRecord | null>;
  latestServableGeneration: (exchange: string, timeframe: string) => Promise<ServableGeneration | null>;
  scanner: RegimeScannerDeps;
}

export const DEFAULT_REGIME_SCAN_HANDLER_DEPS: RegimeScanHandlerDeps = {
  sampledRegimeVenues: () => sampledRegimeVenues(),
  latestRunDisposition,
  latestServableGeneration: (exchange, timeframe) => latestServableGeneration(exchange, timeframe),
  scanner: DEFAULT_REGIME_SCANNER_DEPS,
};

/** The bare identity; every `_algovault` site stamps it with `withAuthState` AT the site, so the
 *  credential-outcome R5 pattern matches each one (tests/auth-refusal-mcp.test.ts counts seven). */
const ident = (): RegimeScanIdentity => ({ tool: SCAN_MARKET_REGIMES_TOOL, version: PKG_VERSION, session_id: getRequestSessionId() ?? null });

/**
 * A pair is SERVED when its producer's newest due disposition is not WINDOW_STALE and it holds a
 * servable generation. Both halves come from the run record — the same two reads the refusal itself
 * is decided by — so an alternative this lists is one the next call would actually serve.
 */
async function isServed(deps: RegimeScanHandlerDeps, exchange: string, timeframe: string): Promise<boolean> {
  const last = await deps.latestRunDisposition(exchange, timeframe);
  if (last?.disposition === 'WINDOW_STALE') return false;
  return (await deps.latestServableGeneration(exchange, timeframe)) !== null;
}

/**
 * Run a regime scan with refusals, quota gating and the envelope. See the header for the order.
 */
export async function runScanMarketRegimes(
  params: ScanMarketRegimesParams,
  license: LicenseInfo,
  deps: RegimeScanHandlerDeps = DEFAULT_REGIME_SCAN_HANDLER_DEPS,
): Promise<ScanMarketRegimesOutcome> {
  const { exchange, timeframe } = params;

  // 1. Parameter refusals. Only a NON-EMPTY unknown lens is invalid — omitted/empty means "no lens".
  const rawRank = params.rankBy;
  const lensNamed = rawRank != null && String(rawRank).trim() !== '';
  if (lensNamed && resolveRankBy(rawRank) == null) {
    const lenses = rankByTokens();
    return {
      kind: 'refused',
      status: 400,
      payload: {
        error: 'invalid_parameter',
        code: 'invalid_parameter',
        param: 'rankBy',
        message: `Unknown rankBy '${String(rawRank)}'. Valid lenses: ${lenses.join(', ')}.`,
        valid_values: lenses,
        suggested_action: `Pass one of: ${lenses.join(', ')} (or omit rankBy to screen the whole venue).`,
        _algovault: withAuthState(ident(), license),
      },
    };
  }
  if (params.sortBy === 'rank' && !lensNamed) {
    return {
      kind: 'refused',
      status: 400,
      payload: {
        error: 'invalid_parameter',
        code: 'invalid_parameter',
        param: 'sortBy',
        message: "sortBy 'rank' orders by a lens, so it needs rankBy.",
        valid_values: ['confidence', 'regime_age'],
        suggested_action: "Pass rankBy with sortBy 'rank', or sort by 'confidence' or 'regime_age'.",
        _algovault: withAuthState(ident(), license),
      },
    };
  }

  // 2. Retired-venue gate — declined by name before anything else is read.
  await assertVenueNotRetired(exchange);

  // 3. Venue sampling.
  const sampled = await deps.sampledRegimeVenues();
  if (!sampled.includes(exchange)) {
    return {
      kind: 'refused',
      status: 400,
      payload: {
        error: 'venue_not_sampled',
        code: 'venue_not_sampled',
        exchange,
        message: `${exchange} is not covered by the regime snapshot.`,
        sampled_venues: [...sampled],
        suggested_action: sampled.length
          ? `Pass one of: ${sampled.join(', ')}. For a single coin on ${exchange}, call get_market_regime.`
          : `For a single coin on ${exchange}, call get_market_regime.`,
        _algovault: withAuthState(ident(), license),
      },
    };
  }

  // 4. Unserved pair — derived from the producer's own record.
  const last = await deps.latestRunDisposition(exchange, timeframe);
  if (last?.disposition === 'WINDOW_STALE') {
    const servedTimeframes: string[] = [];
    for (const tf of REGIME_SNAPSHOT_TIMEFRAMES) {
      if (tf !== timeframe && (await isServed(deps, exchange, tf))) servedTimeframes.push(tf);
    }
    const servingVenues: string[] = [];
    for (const v of sampled) {
      if (v !== exchange && (await isServed(deps, v, timeframe))) servingVenues.push(v);
    }
    const options = [
      ...(servedTimeframes.length ? [`timeframe ${servedTimeframes.join(' or ')} on ${exchange}`] : []),
      ...(servingVenues.length ? [`${timeframe} on ${servingVenues.join(', ')}`] : []),
    ];
    return {
      kind: 'refused',
      status: 400,
      payload: {
        error: 'timeframe_unserved',
        code: 'timeframe_unserved',
        exchange,
        timeframe,
        message: `The ${timeframe} regime snapshot is not available for ${exchange}.`,
        served_timeframes_on_venue: servedTimeframes,
        venues_serving_timeframe: servingVenues,
        suggested_action: options.length ? `Try ${options.join(', or ')}.` : 'Retry later.',
        _algovault: withAuthState(ident(), license),
      },
    };
  }

  // 5. Quota wall — the SAME envelope `scan_trade_calls` renders.
  const entry = checkQuota(license);
  if (!entry.allowed) {
    return {
      kind: 'refused',
      status: 429,
      payload: {
        ...buildScanQuotaWall(SCAN_MARKET_REGIMES_TOOL, entry, license, referralCodeForKey(license.key)),
        _algovault: withAuthState(ident(), license),
      },
    };
  }

  // 6–7. Scan (the engine owns the staleness bound and returns it as an outcome, never a throw).
  const out = await scanMarketRegimes(params, deps.scanner);
  if (out.status === 'stale') {
    return {
      kind: 'refused',
      status: 503,
      payload: {
        error: 'snapshot_stale',
        code: 'snapshot_stale',
        exchange,
        timeframe,
        as_of: out.as_of,
        message: out.as_of
          ? `The newest ${timeframe} regime snapshot for ${exchange} (${out.as_of}) is older than its freshness bound.`
          : `No ${timeframe} regime snapshot is available for ${exchange} yet.`,
        suggested_action: 'Retry after the next bar close, or call get_market_regime for a live read of a single coin.',
        _algovault: withAuthState(ident(), license),
      },
    };
  }

  const tracked = trackCall(license, Math.max(1, out.result.returned));
  return {
    kind: 'ok',
    response: {
      ...out.result,
      _algovault: withAuthState(
        {
          tool: SCAN_MARKET_REGIMES_TOOL,
          version: PKG_VERSION,
          quota: buildScanQuotaState(tracked, license),
          session_id: getRequestSessionId() ?? null,
        },
        license,
      ),
    },
  };
}
