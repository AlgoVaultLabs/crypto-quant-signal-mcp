// ── pre_trade_check tool wrapper (DECISION-CALL-V1-W2 R5) ──
//
// An agent sends its OWN intent — coin, side, size, hold — and gets GO / CAUTION / WAIT with reasons,
// the cheapest venue by round-trip taker fees plus funding over the hold, a size limit, the funding
// timing and the market regime. The engine is `src/lib/pre-trade-decision.ts` (pure, versioned); this
// unit gathers its inputs, owns the refusals, bills, and shapes the response.
//
// ORDER IS THE CONTRACT (`Prompt/pre-trade-check-contract.md` § Refusals). Every refusal is UNBILLED:
//   1. invalid_parameter   400  the declaration's bounds, re-checked here so every channel is held to them
//   2. venue_not_supported 400  `exchanges` names a venue outside the decision set
//   3. the quota wall           `TierLimitReachedError`, composed exactly as `get_market_regime` composes it
//   4. data_unavailable    503  no venue's market data could be read (or none lists the coin and some
//                               could not be read — "not listed" would be a guess)
//   5. coin_not_listed     404  every venue was read and none lists the coin
// then rankVenues → regime + session → decide → trackCall (ONE unit) → the response. Nothing before
// `decide` is billed; a WAIT is a decision and is billed like any other.
//
// INPUTS. The venue universe and the merged funding snapshot come from `venue-market-state.ts` — the
// same single-flight caches `scan_funding_arb` and the scan floor read, so a warm call fetches
// nothing. The snapshot is asked to SKIP every adapter that feeds no priced venue (its `retired`
// argument is the set it does not fetch), so a cold call never spends HL / Gate / KuCoin / Aster weight
// it cannot use. The regime is the newest servable, FRESH bar-close snapshot row for the coin on the
// best venue, else on the next sampled venue — `regimeGenerationFreshness` is the same staleness rule
// `scan_market_regimes` serves by.
//
// NEVER on the wire: a `call`, `verdict`, `reasoning`, `price_at_signal` or `outcome_*` key, a proposed
// side, an edge / return / win-rate claim. The response is built by naming every key
// (`toPreTradeCheckResponse`) — never a spread — and `audits/pre-trade-check-shape-snapshot-*.json`
// pins the allow-list.

import { z } from 'zod';
import {
  rankVenues,
  decide,
  PRE_TRADE_RULE_VERSION,
  SIZE_MAX_PCT_OF_24H_VOLUME,
  type VenueMarketInput,
  type VenueRanking,
  type DecideResult,
  type RegimeRead,
  type PreTradeReason,
  type PreTradeDecision,
} from '../lib/pre-trade-decision.js';
import { decisionVenueSet, staleFeeRows, takerFeeBps, VENUE_FEE_ROWS } from '../lib/venue-fees.js';
import {
  getVenueUniverseState,
  getMergedFundingSnapshot,
  normalizeVenueFunding,
  type VenueUniverseState,
  type MergedFundingSnapshot,
} from '../lib/venue-market-state.js';
import { FUNDING_VENUE_META, FUNDING_ARB_FETCH_ADAPTERS } from '../lib/funding-venues.js';
import { effectiveLiquidityUsd } from '../lib/exchange-universe.js';
import { getRetiredVenueSet } from '../lib/venue-store.js';
import {
  sampledRegimeVenues,
  latestServableGeneration,
  readGenerationRow,
  type RegimeSnapshotRow,
  type ServableGeneration,
} from '../lib/regime-snapshots.js';
import { regimeGenerationFreshness, type RegimeScanTimeframe } from '../lib/market-regime-scanner.js';
import { resolveAssetClass, type ResolvedAssetClass } from '../lib/underlying-type.js';
import { classifyUnderlyingSession, isClosedState } from '../lib/market-sessions.js';
import { getVenueStatus } from '../lib/venue-shadow.js';
import { TierLimitReachedError } from '../lib/errors.js';
import { referralCodeForKey } from '../lib/referral-store.js';
import {
  checkQuota,
  trackCall,
  getUpgradeHint,
  getRequestSessionId,
  getMonthlyQuota,
  monthResetAtMs,
  periodStartMs,
  utcDayResetAtMs,
} from '../lib/license.js';
import { withTierWarning, withQuotaState, withAuthState, DEFAULT_UPGRADE_URL } from '../lib/tier-warning.js';
import { compatibleWith } from '../lib/primitive-projection.js';
import { PKG_VERSION } from '../lib/pkg-version.js';
import {
  PRE_TRADE_CHECK_PARAM_DECL,
  PRE_TRADE_SIDES,
  REGIME_TIMEFRAMES,
  PUBLIC_VENUE_ENUM,
} from '../lib/tool-param-schema.js';
import type { AlgoVaultMeta, ExchangeId, LicenseInfo, VenueStatus } from '../types.js';

export const PRE_TRADE_CHECK_TOOL = 'pre_trade_check' as const;

/** `data_unavailable` tells the caller when to come back — the universe cache's own refresh scale. */
export const PRE_TRADE_DATA_RETRY_AFTER_SECONDS = 30;

const D = PRE_TRADE_CHECK_PARAM_DECL;

/**
 * Zod raw shape for `server.tool`. Every bound and default projects from `PRE_TRADE_CHECK_PARAM_DECL`
 * (tool-param-schema.ts). The enum ARRAYS are named imports — the arrays that declaration references —
 * because the REL-3 relational gate resolves each `z.enum(X)` through the file's named imports.
 * `exchanges` carries no `.default()`: absent means "every venue the tool prices". Uniqueness is not
 * expressible in Zod's JSON Schema; the handler refuses a repeat as `invalid_parameter`.
 */
export const PRE_TRADE_CHECK_SCHEMA = {
  coin: z.string().min(D.coin.minLength).max(D.coin.maxLength),
  side: z.enum(PRE_TRADE_SIDES),
  sizeUsd: z.number().gt(D.sizeUsd.exclusiveMinimum).max(D.sizeUsd.maximum),
  holdHours: z.number().min(D.holdHours.minimum).max(D.holdHours.maximum).default(D.holdHours.default),
  timeframe: z.enum(REGIME_TIMEFRAMES).default(D.timeframe.default),
  exchanges: z.array(z.enum(PUBLIC_VENUE_ENUM)).min(D.exchanges.minItems).max(D.exchanges.maxItems).optional(),
};

/** What the handler accepts. Loosely typed on purpose: it re-validates, so every channel gets one contract. */
export interface PreTradeCheckParams {
  coin: string;
  side: string;
  sizeUsd: number;
  holdHours?: number;
  timeframe?: string;
  exchanges?: readonly string[];
}

// ── Wire types ──────────────────────────────────────────────────────────────────────────────────

/** The envelope identity every refusal carries (stamped by `withAuthState`). */
interface PreTradeIdentity {
  tool: typeof PRE_TRADE_CHECK_TOOL;
  version: string;
  session_id: string | null;
}

export interface PreTradeVenueRow {
  exchange: string;
  listed: boolean | null;
  excluded: string | null;
  liquidity_usd: number | null;
  volume_24h_usd: number | null;
  capacity_usd: number | null;
  size_pct_of_24h_volume: number | null;
  funding_rate: number | null;
  funding_interval_hours: number | null;
  funding_interval_basis: 'contract' | 'declared' | null;
  next_funding_at: string | null;
  funding_events_in_hold: number | null;
  funding_cost_bps: number | null;
  taker_fee_bps: number | null;
  round_trip_fee_bps: number | null;
  est_cost_bps: number | null;
  est_cost_usd: number | null;
  spread_bps: number | null;
  spread_basis: 'top_of_book' | 'unavailable';
}

export interface PreTradeCheckResponse {
  coin: string;
  side: string;
  size_usd: number;
  hold_hours: number;
  timeframe: string;
  decision: PreTradeDecision;
  reasons: PreTradeReason[];
  best_venue: { exchange: string; est_cost_bps: number; est_cost_usd: number; capacity_usd: number } | null;
  size_limit_usd: number | null;
  size_limit_usd_total: number | null;
  split: { exchange: string; size_usd: number; est_cost_bps: number }[] | null;
  timing: {
    exchange: string;
    next_funding_at: string | null;
    minutes_to_next_funding: number | null;
    side_pays_next_funding: boolean;
    saving_bps_if_entered_after_next_funding: number | null;
  } | null;
  regime: { label: string; confidence: number; timeframe: string; as_of: string; source_exchange: string } | null;
  underlying_session: string | null;
  venues: PreTradeVenueRow[];
  assumptions: { funding: string; fees: string; size_guard_pct_of_24h_volume: number };
  fee_table_verified_at: string;
  rule_version: number;
  as_of: string;
  _algovault: AlgoVaultMeta;
}

export type PreTradeCheckRefusal =
  | { error: 'invalid_parameter'; code: 'invalid_parameter'; param: string; message: string; suggested_action: string; _algovault: PreTradeIdentity }
  | { error: 'venue_not_supported'; code: 'venue_not_supported'; requested: string[]; supported_venues: string[]; message: string; suggested_action: string; _algovault: PreTradeIdentity }
  | { error: 'data_unavailable'; code: 'data_unavailable'; retry_after_seconds: number; message: string; suggested_action: string; _algovault: PreTradeIdentity }
  | { error: 'coin_not_listed'; code: 'coin_not_listed'; coin: string; supported_venues: string[]; message: string; suggested_action: string; _algovault: PreTradeIdentity };

/** The handler's outcome. `status` is the HTTP-equivalent status of a refusal, for the pipeline. */
export type PreTradeCheckOutcome =
  | { kind: 'ok'; response: PreTradeCheckResponse }
  | { kind: 'refused'; payload: PreTradeCheckRefusal; status: number };

// ── Seams ───────────────────────────────────────────────────────────────────────────────────────

/** Everything the handler reads besides the pure engine. A seam so tests run with no DB and no network. */
export interface PreTradeCheckDeps {
  now: () => number;
  retiredVenues: () => Promise<ReadonlySet<string>>;
  venueUniverse: (exchange: ExchangeId) => Promise<VenueUniverseState>;
  /** The merged funding snapshot, NOT fetching any adapter in `skip`. */
  fundingSnapshot: (skip: ReadonlySet<string>) => Promise<MergedFundingSnapshot>;
  sampledRegimeVenues: () => Promise<readonly string[]>;
  latestServableGeneration: (exchange: string, timeframe: string) => Promise<ServableGeneration | null>;
  readGenerationRow: (exchange: string, timeframe: string, barCloseMs: number, coin: string) => Promise<RegimeSnapshotRow | null>;
  resolveAssetClass: (coin: string, exchange: ExchangeId) => Promise<ResolvedAssetClass>;
  venueStatus: (exchange: ExchangeId) => Promise<VenueStatus>;
}

export const DEFAULT_PRE_TRADE_CHECK_DEPS: PreTradeCheckDeps = {
  now: () => Date.now(),
  retiredVenues: () => getRetiredVenueSet(),
  venueUniverse: getVenueUniverseState,
  fundingSnapshot: getMergedFundingSnapshot,
  sampledRegimeVenues: () => sampledRegimeVenues(),
  latestServableGeneration: (exchange, timeframe) => latestServableGeneration(exchange, timeframe),
  readGenerationRow,
  resolveAssetClass,
  venueStatus: getVenueStatus,
};

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────

const ident = (): PreTradeIdentity => ({ tool: PRE_TRADE_CHECK_TOOL, version: PKG_VERSION, session_id: getRequestSessionId() ?? null });

interface Normalized {
  coin: string;
  side: 'long' | 'short';
  sizeUsd: number;
  holdHours: number;
  timeframe: RegimeScanTimeframe;
  exchanges: string[] | null;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The declaration's bounds, re-checked: the first violation, or the normalized params. */
function validate(p: PreTradeCheckParams): { ok: true; params: Normalized } | { ok: false; param: string; message: string; suggested_action: string } {
  const coin = typeof p.coin === 'string' ? p.coin.trim().toUpperCase() : '';
  if (coin.length < D.coin.minLength || coin.length > D.coin.maxLength) {
    return { ok: false, param: 'coin', message: `coin must be an asset symbol of ${D.coin.minLength} to ${D.coin.maxLength} characters.`, suggested_action: 'Pass the base asset only, e.g. BTC, ETH or SOL.' };
  }
  if (!(PRE_TRADE_SIDES as readonly unknown[]).includes(p.side)) {
    return { ok: false, param: 'side', message: `side must be one of: ${PRE_TRADE_SIDES.join(', ')}.`, suggested_action: 'Pass long or short — the direction of the order you intend to place.' };
  }
  if (!isNum(p.sizeUsd) || !(p.sizeUsd > D.sizeUsd.exclusiveMinimum) || p.sizeUsd > D.sizeUsd.maximum) {
    return { ok: false, param: 'sizeUsd', message: `sizeUsd must be above ${D.sizeUsd.exclusiveMinimum} and at most ${D.sizeUsd.maximum.toLocaleString('en-US')}.`, suggested_action: 'Pass the order notional in USD, e.g. 10000.' };
  }
  const holdHours = p.holdHours ?? D.holdHours.default;
  if (!isNum(holdHours) || holdHours < D.holdHours.minimum || holdHours > D.holdHours.maximum) {
    return { ok: false, param: 'holdHours', message: `holdHours must be between ${D.holdHours.minimum} and ${D.holdHours.maximum}.`, suggested_action: `Pass the expected holding time in hours, or omit it for ${D.holdHours.default}.` };
  }
  const timeframe = p.timeframe ?? D.timeframe.default;
  if (!(D.timeframe.values as readonly string[]).includes(timeframe)) {
    return { ok: false, param: 'timeframe', message: `timeframe must be one of: ${D.timeframe.values.join(', ')}.`, suggested_action: `Pass one of: ${D.timeframe.values.join(', ')} (or omit for ${D.timeframe.default}).` };
  }
  let exchanges: string[] | null = null;
  if (p.exchanges !== undefined) {
    const list = Array.isArray(p.exchanges) ? [...p.exchanges] : null;
    const known = new Set<string>(D.exchanges.values);
    if (!list || list.length < D.exchanges.minItems || list.length > D.exchanges.maxItems || !list.every((e) => typeof e === 'string' && known.has(e))) {
      return { ok: false, param: 'exchanges', message: `exchanges must list ${D.exchanges.minItems} to ${D.exchanges.maxItems} supported venue ids.`, suggested_action: 'Pass venue ids such as BINANCE or OKX, or omit exchanges to compare every supported venue.' };
    }
    if (new Set(list).size !== list.length) {
      return { ok: false, param: 'exchanges', message: 'exchanges lists a venue more than once.', suggested_action: 'Name each venue once.' };
    }
    exchanges = list;
  }
  return { ok: true, params: { coin, side: p.side as 'long' | 'short', sizeUsd: p.sizeUsd, holdHours, timeframe: timeframe as RegimeScanTimeframe, exchanges } };
}

// ── The response: every key named ───────────────────────────────────────────────────────────────

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** The contract's assumptions block — stated on every response, never implied. */
const ASSUMPTIONS = Object.freeze({
  funding: 'current rate held for the whole hold',
  fees: 'base-tier taker, no discounts; per-pair exceptions not modelled',
  size_guard_pct_of_24h_volume: SIZE_MAX_PCT_OF_24H_VOLUME * 100,
});

export interface PreTradeResponseInput {
  coin: string;
  side: string;
  sizeUsd: number;
  holdHours: number;
  timeframe: string;
  nowMs: number;
  ranking: VenueRanking;
  decided: DecideResult;
  regime: RegimeRead | null;
  underlyingSession: string | null;
  feeTableVerifiedAt: string;
}

/**
 * EXPORTED allow-list formatter. Every public key is copied by name from the engine's typed output —
 * never a spread — so a field added to the engine cannot reach the wire without being named here and
 * in the shape snapshot.
 */
export function toPreTradeCheckResponse(a: PreTradeResponseInput, meta: AlgoVaultMeta, license: LicenseInfo): PreTradeCheckResponse {
  const { ranking, decided } = a;
  const best = ranking.best;
  const t = decided.timing;
  return {
    coin: a.coin,
    side: a.side,
    size_usd: a.sizeUsd,
    hold_hours: a.holdHours,
    timeframe: a.timeframe,
    decision: decided.decision,
    reasons: decided.reasons.map((r) => ({ code: r.code, severity: r.severity, detail: r.detail })),
    best_venue: best
      ? { exchange: best.exchange, est_cost_bps: best.estCostBps as number, est_cost_usd: best.estCostUsd as number, capacity_usd: best.capacityUsd as number }
      : null,
    size_limit_usd: ranking.sizeLimitUsd,
    size_limit_usd_total: ranking.sizeLimitUsdTotal,
    split: ranking.split ? ranking.split.map((l) => ({ exchange: l.exchange, size_usd: l.sizeUsd, est_cost_bps: l.estCostBps })) : null,
    timing: t
      ? {
          exchange: t.exchange,
          next_funding_at: iso(t.nextFundingAtMs),
          minutes_to_next_funding: t.minutesToNextFunding,
          side_pays_next_funding: t.sidePaysNextFunding,
          saving_bps_if_entered_after_next_funding: t.savingBpsIfEnteredAfterNextFunding,
        }
      : null,
    regime: a.regime
      ? { label: a.regime.label, confidence: a.regime.confidence, timeframe: a.regime.timeframe, as_of: iso(a.regime.asOfMs) as string, source_exchange: a.regime.sourceExchange }
      : null,
    underlying_session: a.underlyingSession,
    venues: ranking.venues.map((v) => ({
      exchange: v.exchange,
      listed: v.listed,
      excluded: v.excluded,
      liquidity_usd: v.liquidityUsd,
      volume_24h_usd: v.volume24hUsd,
      capacity_usd: v.capacityUsd,
      size_pct_of_24h_volume: v.sizePctOf24hVolume,
      funding_rate: v.fundingRate,
      funding_interval_hours: v.fundingIntervalHours,
      funding_interval_basis: v.fundingIntervalBasis,
      next_funding_at: iso(v.nextFundingAtMs),
      funding_events_in_hold: v.fundingEventsInHold,
      funding_cost_bps: v.fundingCostBps,
      taker_fee_bps: v.takerFeeBps,
      round_trip_fee_bps: v.roundTripFeeBps,
      est_cost_bps: v.estCostBps,
      est_cost_usd: v.estCostUsd,
      spread_bps: v.spreadBps,
      spread_basis: v.spreadBasis,
    })),
    assumptions: { funding: ASSUMPTIONS.funding, fees: ASSUMPTIONS.fees, size_guard_pct_of_24h_volume: ASSUMPTIONS.size_guard_pct_of_24h_volume },
    fee_table_verified_at: a.feeTableVerifiedAt,
    rule_version: PRE_TRADE_RULE_VERSION,
    as_of: new Date(a.nowMs).toISOString(),
    _algovault: withAuthState(meta, license),
  };
}

// ── Gathering ───────────────────────────────────────────────────────────────────────────────────

/** The funding adapters to SKIP: the retired, plus every adapter that feeds no venue in `venues`. */
function fundingSkipSet(venues: readonly string[], retired: ReadonlySet<string>): Set<string> {
  const needed = new Set<string>(
    Object.values(FUNDING_VENUE_META).filter((m) => venues.includes(m.exchangeId)).map((m) => m.fetchedVia),
  );
  return new Set<string>([...retired, ...FUNDING_ARB_FETCH_ADAPTERS.filter((a) => !needed.has(a))]);
}

/** One venue's market input for the coin, from the shared universe + funding snapshot. */
function venueInput(exchange: ExchangeId, coin: string, universe: VenueUniverseState, funding: MergedFundingSnapshot): VenueMarketInput {
  const row = universe.failed ? undefined : universe.rows.find((r) => r.coin === coin);
  const fRow = (funding.byCoin.get(coin) ?? []).find((r) => FUNDING_VENUE_META[r.venue]?.exchangeId === exchange);
  const n = fRow ? normalizeVenueFunding(fRow) : null;
  return {
    exchange,
    universeOk: !universe.failed,
    fundingFeedOk: !funding.failedVenues.has(exchange),
    asset: row
      ? { liquidityUsd: effectiveLiquidityUsd(row), volume24hUsd: Number.isFinite(row.volume24h_usd) ? row.volume24h_usd : null, bidPx: row.bidPx, askPx: row.askPx }
      : null,
    funding: n
      ? { rate: n.rate, intervalHours: n.intervalHours, intervalBasis: n.intervalBasis, nextFundingTime: Number.isFinite(n.nextFundingTime) && n.nextFundingTime > 0 ? n.nextFundingTime : null }
      : null,
    takerFeeBps: takerFeeBps(exchange),
  };
}

/** The regime: the best venue's newest servable FRESH snapshot row for the coin, else the next sampled venue's. */
async function readRegime(deps: PreTradeCheckDeps, coin: string, timeframe: RegimeScanTimeframe, nowMs: number, best: string | null): Promise<RegimeRead | null> {
  const sampled = await deps.sampledRegimeVenues();
  const order = best && sampled.includes(best) ? [best, ...sampled.filter((v) => v !== best)] : [...sampled];
  for (const venue of order) {
    const gen = await deps.latestServableGeneration(venue, timeframe);
    if (!gen || !regimeGenerationFreshness(gen, timeframe, nowMs).fresh) continue;
    const row = await deps.readGenerationRow(venue, timeframe, gen.bar_close_ms, coin);
    if (row) return { label: row.regime, confidence: row.confidence, timeframe, asOfMs: gen.bar_close_ms, sourceExchange: venue };
  }
  return null;
}

// ── The handler ─────────────────────────────────────────────────────────────────────────────────

/**
 * Run a pre-trade check: refusals in contract order, gather, rank, decide, bill ONE unit, respond.
 * The quota wall THROWS `TierLimitReachedError` (rendered by the pipeline, as for `get_market_regime`);
 * every other refusal is an in-band outcome.
 */
export async function runPreTradeCheck(
  params: PreTradeCheckParams,
  license: LicenseInfo,
  deps: PreTradeCheckDeps = DEFAULT_PRE_TRADE_CHECK_DEPS,
): Promise<PreTradeCheckOutcome> {
  // 1. invalid_parameter
  const v = validate(params);
  if (!v.ok) {
    return {
      kind: 'refused',
      status: 400,
      payload: { error: 'invalid_parameter', code: 'invalid_parameter', param: v.param, message: v.message, suggested_action: v.suggested_action, _algovault: withAuthState(ident(), license) },
    };
  }
  const { coin, side, sizeUsd, holdHours, timeframe } = v.params;

  // 2. venue_not_supported — the decision set is fee rows ∩ funding venues − retired.
  const retired = await deps.retiredVenues();
  const supported = decisionVenueSet(retired);
  const requested = v.params.exchanges;
  const unsupported = requested ? requested.filter((e) => !supported.includes(e as ExchangeId)) : [];
  if (supported.length === 0 || unsupported.length > 0) {
    return {
      kind: 'refused',
      status: 400,
      payload: {
        error: 'venue_not_supported',
        code: 'venue_not_supported',
        requested: requested ?? [],
        supported_venues: [...supported],
        message: unsupported.length
          ? `${unsupported.join(', ')} ${unsupported.length === 1 ? 'is' : 'are'} not priced by pre_trade_check.`
          : 'No venue is currently priced by pre_trade_check.',
        suggested_action: supported.length
          ? `Pass any of: ${supported.join(', ')} — or omit exchanges to compare them all.`
          : 'Retry later.',
        _algovault: withAuthState(ident(), license),
      },
    };
  }
  const venues: ExchangeId[] = requested ? supported.filter((s) => requested.includes(s)) : supported;

  // 3. The quota wall — composed exactly as get_market_regime composes it: read-only gate, no charge.
  const gate = checkQuota(license);
  if (!gate.allowed) {
    const isDailyWall = gate.limit === 'daily';
    throw new TierLimitReachedError({
      currentUsage: gate.used,
      monthlyLimit: gate.total,
      tier: license.tier,
      suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter&utm_source=mcp_tool&utm_campaign=tier_limit_reached',
      resetAtMs: isDailyWall ? utcDayResetAtMs() : monthResetAtMs(license),
      periodStartMs: periodStartMs(license),
      referralCode: referralCodeForKey(license.key),
      tool: PRE_TRADE_CHECK_TOOL,
      wall: isDailyWall ? 'daily' : 'monthly',
      dailyUsed: gate.daily_used,
      dailyLimit: gate.daily_total,
    });
  }

  // Gather: one universe read per venue and one merged funding snapshot, all from the shared caches.
  const nowMs = deps.now();
  const [universes, funding] = await Promise.all([
    Promise.all(venues.map((e) => deps.venueUniverse(e))),
    deps.fundingSnapshot(fundingSkipSet(venues, retired)),
  ]);
  const inputs = venues.map((e, i) => venueInput(e, coin, universes[i], funding));

  // 4. data_unavailable · 5. coin_not_listed
  const feedDown = inputs.every((x) => !x.universeOk || !x.fundingFeedOk);
  const anyListed = inputs.some((x) => x.universeOk && x.asset !== null);
  if (feedDown || (!anyListed && inputs.some((x) => !x.universeOk))) {
    return {
      kind: 'refused',
      status: 503,
      payload: {
        error: 'data_unavailable',
        code: 'data_unavailable',
        retry_after_seconds: PRE_TRADE_DATA_RETRY_AFTER_SECONDS,
        message: 'Venue market data is temporarily unavailable, so this order cannot be checked right now.',
        suggested_action: `Retry in ${PRE_TRADE_DATA_RETRY_AFTER_SECONDS} seconds.`,
        _algovault: withAuthState(ident(), license),
      },
    };
  }
  if (!anyListed) {
    return {
      kind: 'refused',
      status: 404,
      payload: {
        error: 'coin_not_listed',
        code: 'coin_not_listed',
        coin,
        supported_venues: [...venues],
        message: `${coin} is not listed as a perpetual on ${venues.join(', ')}.`,
        suggested_action: 'Check the symbol: pass the base asset only, e.g. BTC (no USDT suffix).',
        _algovault: withAuthState(ident(), license),
      },
    };
  }

  // Rank → regime + session → decide.
  const ranking = rankVenues({ venues: inputs, side, sizeUsd, holdHours, nowMs });
  const best = ranking.best;
  const regime = await readRegime(deps, coin, timeframe, nowMs, best?.exchange ?? null);
  const refVenue = (best?.exchange ?? inputs.find((x) => x.asset !== null)?.exchange ?? venues[0]) as ExchangeId;
  const assetClass = await deps.resolveAssetClass(coin, refVenue);
  const session = assetClass === 'UNKNOWN' ? 'UNKNOWN' : classifyUnderlyingSession({ assetClass, at: new Date(nowMs) }).state;
  const priced = new Set<string>(venues);
  const feeRows = VENUE_FEE_ROWS.filter((r) => priced.has(r.exchange));
  const decided = decide({
    coin,
    side,
    sizeUsd,
    holdHours,
    timeframe,
    nowMs,
    ranking,
    regime,
    underlyingClosed: isClosedState(session),
    staleFees: staleFeeRows(nowMs, feeRows).map((r) => ({ exchange: r.exchange, verifiedAt: r.verifiedAt })),
  });

  // Bill ONE unit — the first write of the call, after the decision exists.
  const quota = trackCall(license);

  // `_algovault` as get_market_regime composes it.
  const upgradeHint = getUpgradeHint(license, { used: quota.used, total: quota.total, dailyUsed: quota.daily_used, dailyTotal: quota.daily_total });
  let meta: AlgoVaultMeta = {
    version: PKG_VERSION,
    tool: PRE_TRADE_CHECK_TOOL,
    compatible_with: compatibleWith(),
    session_id: getRequestSessionId() ?? null,
    ...(best ? { exchange: best.exchange as ExchangeId, venue_status: await deps.venueStatus(best.exchange as ExchangeId) } : {}),
  };
  if (upgradeHint) meta.upgrade_hint = upgradeHint;
  meta = withTierWarning(meta, {
    tier: license.tier,
    currentUsage: quota.used,
    monthlyLimit: quota.total || getMonthlyQuota(license.tier),
    dailyUsage: quota.daily_used,
    dailyLimit: quota.daily_total,
    monthlyResetAtMs: monthResetAtMs(license),
    dailyResetAtMs: utcDayResetAtMs(),
    isBotInternal: license.tier === 'internal',
    upgradeUrl: DEFAULT_UPGRADE_URL,
    tool: PRE_TRADE_CHECK_TOOL,
  });
  meta = withQuotaState(meta, {
    tier: license.tier,
    used: quota.used,
    total: quota.total || getMonthlyQuota(license.tier),
    resetAtMs: monthResetAtMs(license),
    dailyUsed: quota.daily_used,
    dailyTotal: quota.daily_total,
    dailyResetAtMs: utcDayResetAtMs(),
    isBotInternal: license.tier === 'internal',
  });

  const oldestVerified = feeRows.map((r) => r.verifiedAt).sort()[0] ?? '';
  return {
    kind: 'ok',
    response: toPreTradeCheckResponse(
      { coin, side, sizeUsd, holdHours, timeframe, nowMs, ranking, decided, regime, underlyingSession: session, feeTableVerifiedAt: oldestVerified },
      meta,
      license,
    ),
  };
}
