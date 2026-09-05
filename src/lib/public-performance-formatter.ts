/**
 * public-performance-formatter.ts — DEV-TRACK-RECORD-TOOL-PARITY-W1 CH2.
 *
 * The ONE exported allow-list formatter behind EVERY public projection of the signal
 * track record. Three channels, one derivation:
 *   - `performance://signal-performance`  MCP resource   (src/index.ts)
 *   - `GET /api/performance-public`       HTTP endpoint  (src/index.ts)
 *   - `get_track_record`                  MCP tool       (src/tools/get-track-record.ts)
 *
 * WHY THIS MODULE EXISTS. `/api/performance-public` carried the public-safety filtering
 * INLINE, and the MCP resource carried none — so the resource published rows the endpoint
 * deliberately withholds. Measured 2026-08-28: the resource itemised 17 venues against the
 * endpoint's 14 (BITMART `retired`, EDGEX `retired`, WEEX `shadow`), served the `1m`
 * shadow timeframe the endpoint strips, and carried an `equities` block absent from the
 * endpoint's published allow-list while equities are under a standing public-copy HOLD.
 * BITMART is the sharp end: the estate has WITHDRAWN that venue, and a public surface was
 * still itemising its per-asset track record. Adding a third channel with a fourth copy of
 * the filter would have made that worse, so the filter moved HERE and every channel calls it.
 * This is the generator fix for SV-02 (`OPS-AUDIT-REMEDIATION-MED-W1`), whose fail-closed
 * repair only ever reached the HTTP lane.
 *
 * THREE PROPERTIES, EACH LOAD-BEARING:
 *
 *  1. ONE FUNCTION, ALL CHANNELS. If a caller re-implements any part of this, the wave has
 *     added a lane instead of retiring one. `formatPublicPerformance` is the only place a
 *     public per-venue or per-timeframe row is admitted.
 *
 *  2. ALLOW-LIST BY CONSTRUCTION, never a deny-list — the same discipline as
 *     `venue-public-formatter.ts`. The output object is BUILT by naming the permitted keys;
 *     `stats` is never spread. A venue absent from the promoted set is absent from the
 *     output with no edit, so the next shadow or retired venue is safe by default, and a
 *     field added to `PerformanceStats` tomorrow cannot leak through.
 *
 *  3. FAIL-CLOSED. An unreadable or empty `venues` table yields NO per-venue rows — never a
 *     fall-through to unfiltered. That fall-through IS the SV-02 incident; the comment it
 *     left behind in `index.ts` records that a venues-table outage once leaked shadow rows
 *     onto the public surface.
 *
 * ON THE VENUE ALLOW-LIST'S TWO SOURCES. `getActivePromotedVenueIds()` (venue-store.ts) is
 * documented FAIL-OPEN by design and asserted so by its own test: a retired-set read error
 * returns the FULL static `PROMOTED_VENUE_IDS`, because for a registry that DRIVES LIVE API
 * CALLS, wrongly dropping a live venue costs data while wrongly keeping one costs a few
 * wasted calls. That direction is correct there and exactly wrong here — a public
 * disclosure allow-list must shrink under uncertainty, not grow. So the allow-list is the
 * INTERSECTION of the fail-CLOSED DB read (`listVenues('promoted')`) with the retired
 * subtraction. Measured today both legs yield the same 14 ids, so behaviour is unchanged;
 * the intersection is what keeps the guarantee under a partial outage.
 */
import type { PerformanceStats } from '../types.js';

/**
 * Shadow-mode timeframes, stripped from `byTimeframe` unless explicitly revealed.
 * Moved here VERBATIM from the `/api/performance-public` handler (SHADOW-SEED-W1):
 * `SHADOW_REVEAL_TIMEFRAMES` is a comma-list env flag toggling individual timeframes back
 * on; default = both hidden. To unlock 3m only: `SHADOW_REVEAL_TIMEFRAMES=3m` + container
 * restart. To unlock both: `SHADOW_REVEAL_TIMEFRAMES=1m,3m`.
 */
export const SHADOW_TIMEFRAMES = ['1m', '3m'] as const;

/** The optional heavy breakdowns a caller may ask for by name. */
export const PUBLIC_PERF_SECTIONS = ['byAsset', 'byExchange', 'recentSignals'] as const;
export type PublicPerfSection = (typeof PUBLIC_PERF_SECTIONS)[number];

/**
 * Keys that MUST NEVER appear on any public track-record surface. Enforced BY CONSTRUCTION
 * (never read into the output), so this list is a contract assertion the shape-snapshot and
 * unit tests pin — not a runtime filter.
 *
 * These are KEY NAMES and must be asserted as such — over the payload's key set, never as
 * substrings of the serialised body. `call` and `confidence` are forbidden as recentSignals
 * FIELD names (the PERFORMANCE-PUBLIC-SANITIZE-W1 leak) and both are substrings of perfectly
 * legitimate keys (`totalCalls`, `byCallType`), so a substring grep reports a leak on every
 * healthy response — a guard that cries wolf once is ignored forever.
 *
 * `equities` is here because it is present in the producer-adjacent resource payload TODAY
 * and absent from `audits/api-performance-public-shape-snapshot-2026-07-15.json.allowed_keys`,
 * and because equities are under the standing public-copy HOLD that keeps both equity tools
 * `publicListing: false`. The rest are the Phase-E / internal families from the Data
 * Integrity LAW.
 */
export const PUBLIC_PERF_FORBIDDEN_KEYS = [
  'equities',
  'outcome_return_pct',
  'outcome_price',
  'outcome_won',
  'phase_e_wr',
  'eligible_non_hold',
  'call',
  'confidence',
  // OPS-OUTCOME-BACKFILL-STALL-W1 A1 — the three producer-bookkeeping columns added to `signals`.
  // They carry no outcome VALUE and are not themselves an internal-WR family, so the ban is
  // defence-in-depth rather than a Data Integrity necessity: they are operational internals that
  // no public consumer has ever been shaped to receive, and the shape snapshot's `allowed_keys`
  // does not list them. `equity_verdicts.outcome_filled_at` is already excluded from that store's
  // public tool path for exactly the same reason — one convention, applied on both tables.
  'outcome_filled_at',
  'outcome_attempts',
  'outcome_last_attempt_at',
] as const;

/** The resolved public-disclosure allow-list. Build it with {@link resolvePublicPerformanceAllowList}. */
export interface PublicPerformanceAllowList {
  /**
   * Venue ids admitted to `byExchange`. EMPTY means "emit no per-venue rows" — it never
   * means "emit all of them".
   */
  venues: ReadonlySet<string>;
  /** Shadow timeframes explicitly revealed by `SHADOW_REVEAL_TIMEFRAMES`. */
  revealedShadowTimeframes: ReadonlySet<string>;
  /**
   * True when the venue read FAILED (as opposed to legitimately returning no promoted
   * venues). Callers use it to distinguish "nothing to show" from "could not tell", which
   * is the same INDETERMINATE-vs-FAIL line the gate rules draw. It never widens the output.
   */
  degraded: boolean;
}

/** Parse `SHADOW_REVEAL_TIMEFRAMES` at call time (not module load) so tests can vary it. */
function readRevealedShadowTimeframes(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  return new Set(
    (env.SHADOW_REVEAL_TIMEFRAMES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Resolve the public-disclosure allow-list. FAIL-CLOSED: any read error yields an EMPTY
 * venue set plus `degraded: true`.
 *
 * Dynamically imports `venue-store` so this module stays importable by pure consumers (and
 * by tests) without dragging the DB layer in — the same lazy-import shape `capabilities.ts`
 * uses for the same reason.
 */
export async function resolvePublicPerformanceAllowList(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublicPerformanceAllowList> {
  const revealedShadowTimeframes = readRevealedShadowTimeframes(env);
  try {
    const { listVenues, getActivePromotedVenueIds } = await import('./venue-store.js');
    // Fail-CLOSED leg: the DB's own `status='promoted'` rows. An empty table yields an
    // empty set, which is the SV-02 contract — empty, never all.
    const promoted = await listVenues('promoted');
    // Retired subtraction. This leg is fail-OPEN inside venue-store by design, so it is
    // used to NARROW the fail-closed leg and never to widen it.
    const active = new Set<string>(await getActivePromotedVenueIds());
    const venues = new Set(promoted.map((v) => v.exchange_id).filter((id) => active.has(id)));
    return { venues, revealedShadowTimeframes, degraded: false };
  } catch (err) {
    console.error(
      '[public-performance] venue allow-list read failed → fail-CLOSED → no per-venue rows:',
      err instanceof Error ? err.message : err,
    );
    return { venues: new Set(), revealedShadowTimeframes, degraded: true };
  }
}

/** An allow-list that admits nothing. For tests and for callers with no DB. */
export function emptyPublicPerformanceAllowList(): PublicPerformanceAllowList {
  return { venues: new Set(), revealedShadowTimeframes: new Set(), degraded: true };
}

/** True iff `tf` may appear on a public surface under `allow`. */
export function isPublicTimeframe(tf: string, allow: PublicPerformanceAllowList): boolean {
  return !(SHADOW_TIMEFRAMES as readonly string[]).includes(tf) || allow.revealedShadowTimeframes.has(tf);
}

/**
 * OPS-RECENT-SIGNALS-VENUE-FILTER-W1 — the ROW predicate.
 *
 * The venue allow-list, exposed for the per-ROW lane. `formatPublicPerformance` below governs
 * the AGGREGATE sections (`byExchange` keys); this is the same set applied to individual rows —
 * `recentSignals` — which are produced upstream in `performance-db.ts` and reach every public
 * channel already sliced.
 *
 * WHY IT LIVES HERE AND NOT IN THE PRODUCER. The producer would otherwise need its own venue
 * source, and "an allow-list applied to one output shape and not another" is precisely the bug
 * class the aggregate wave retired. There is ONE resolved set
 * ({@link resolvePublicPerformanceAllowList}) and both shapes read it.
 *
 * FAIL-CLOSED by construction: an empty `allow.venues` admits nothing, which is the same
 * direction the aggregate path takes and the SV-02 contract requires.
 */
export function isPublicVenue(exchange: string | null | undefined, allow: PublicPerformanceAllowList): boolean {
  return allow.venues.has(exchange || 'HL');
}

type TfAgg = { count: number; evaluated: number; pfeWinRate: number | null };
type AssetAgg = { count: number; tier: number; pfeWinRate: number | null };

/** The public track-record shape. Optional members are the `include`-gated sections. */
export interface PublicPerformance {
  totalCalls: number;
  period: { from: string; to: string };
  overall: { totalCalls: number; totalEvaluated: number; pfeWinRate: number | null };
  byCallType: Record<string, TfAgg>;
  byTimeframe: Record<string, TfAgg>;
  byAsset?: Record<string, AssetAgg>;
  byExchange?: PerformanceStats['byExchange'];
  byTier: PerformanceStats['byTier'];
  recentSignals?: PerformanceStats['recentSignals'];
  methodology: Record<string, unknown>;
}

const pickTfAgg = (a: TfAgg): TfAgg => ({ count: a.count, evaluated: a.evaluated, pfeWinRate: a.pfeWinRate });
const pickAssetAgg = (a: AssetAgg): AssetAgg => ({ count: a.count, tier: a.tier, pfeWinRate: a.pfeWinRate });

function pickTfMap(m: Record<string, TfAgg> | undefined, allow?: PublicPerformanceAllowList): Record<string, TfAgg> {
  const out: Record<string, TfAgg> = {};
  for (const [k, v] of Object.entries(m ?? {})) {
    if (allow && !isPublicTimeframe(k, allow)) continue;
    out[k] = pickTfAgg(v);
  }
  return out;
}

function pickAssetMap(m: Record<string, AssetAgg> | undefined): Record<string, AssetAgg> {
  const out: Record<string, AssetAgg> = {};
  for (const [k, v] of Object.entries(m ?? {})) out[k] = pickAssetAgg(v);
  return out;
}

/**
 * The single public projection of `PerformanceStats`.
 *
 * `include` widens the SECTIONS returned; it never widens the ROWS disclosed. `byExchange`
 * and `recentSignals` pass through the allow-list whether or not they were asked for by
 * name, and the shadow-timeframe strip applies to the top-level `byTimeframe` AND to each
 * admitted venue's nested `byTimeframe`.
 *
 * Key insertion order matches `PerformanceStats`' declaration order, so a caller that
 * includes every section serialises byte-identically to the pre-extraction handler.
 */
export function formatPublicPerformance(
  stats: PerformanceStats,
  allow: PublicPerformanceAllowList,
  opts: { include?: readonly PublicPerfSection[] } = {},
): PublicPerformance {
  const include = opts.include ?? PUBLIC_PERF_SECTIONS;
  const wants = (s: PublicPerfSection): boolean => include.includes(s);

  const out: PublicPerformance = {
    totalCalls: stats.totalCalls,
    period: { from: stats.period?.from ?? '', to: stats.period?.to ?? '' },
    overall: {
      totalCalls: stats.overall?.totalCalls ?? 0,
      totalEvaluated: stats.overall?.totalEvaluated ?? 0,
      pfeWinRate: stats.overall?.pfeWinRate ?? null,
    },
    byCallType: pickTfMap(stats.byCallType),
    byTimeframe: pickTfMap(stats.byTimeframe, allow),
  } as PublicPerformance;

  if (wants('byAsset')) out.byAsset = pickAssetMap(stats.byAsset);

  if (wants('byExchange')) {
    const byExchange: PerformanceStats['byExchange'] = {};
    for (const [ex, agg] of Object.entries(stats.byExchange ?? {})) {
      if (!allow.venues.has(ex)) continue;
      byExchange[ex] = {
        exchange: agg.exchange,
        count: agg.count,
        evaluated: agg.evaluated,
        pfeWinRate: agg.pfeWinRate,
        byTimeframe: pickTfMap(agg.byTimeframe, allow),
        byTier: pickTfMap(agg.byTier),
        byCallType: pickTfMap(agg.byCallType),
        byAsset: pickAssetMap(agg.byAsset),
      };
    }
    out.byExchange = byExchange;
  }

  const byTier: PerformanceStats['byTier'] = {};
  for (const [k, t] of Object.entries(stats.byTier ?? {})) {
    byTier[k] = {
      tier: t.tier, name: t.name, label: t.label, color: t.color,
      count: t.count, evaluated: t.evaluated, pfeWinRate: t.pfeWinRate, assets: t.assets,
    };
  }
  out.byTier = byTier;

  if (wants('recentSignals')) {
    out.recentSignals = (stats.recentSignals ?? []).map((s) => ({
      id: s.id, coin: s.coin, timeframe: s.timeframe, tier: s.tier,
      created_at: s.created_at, exchange: s.exchange,
    }));
  }

  // Allow-listed by NAME, deliberately. `methodology` is a static producer constant with no
  // caller data in it, but naming its keys keeps the by-construction property total: a new
  // methodology key reaches the public surface only when someone adds it here. That is a
  // GATE and not silent loss — `public-performance-formatter.test.ts` asserts this list
  // equals the producer's `METHODOLOGY` key set, so adding one there fails the build until
  // it is admitted here.
  const m = (stats.methodology ?? {}) as Record<string, unknown>;
  out.methodology = {
    pfeWinRate: m.pfeWinRate,
    note: m.note,
    evaluationWindows: m.evaluationWindows,
    dataSource: m.dataSource,
    signalFilter: m.signalFilter,
  };

  return out;
}
