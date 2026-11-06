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
//
// V2 (DECISION-CALL-V2-W1, `Prompt/pre-trade-check-contract-v2.md`). Optional inputs — `leverage`,
// `stopPct`, `targetPct`, `equityUsd`, `orderType` — add survival and break-even figures per venue
// (`pre-trade-calc.ts`): the round trip with spread, the accuracy the hold needs, isolated liquidation from
// each venue's own tier table (`venue-margin-tiers.ts`, read ONLY when `leverage` is sent) and the
// percent-of-equity figures. sigma comes from one 1h snapshot read beside the regime read, by the same
// walk and freshness rule. The checks are rules (`pre-trade-rules.ts`): every active rule — the caller's
// `rules` and the defaults not switched off — is evaluated on every candidate venue, the decision venue is
// v1's order behind the rules' key (`decisionKey`), and `decide` reads that venue's results. A call without a
// v2 input decides exactly as v1 did. The tool computes and checks; it never proposes a size, leverage, stop
// or target.
//
// V2.1 (DECISION-CALL-V2-W2, contract § v2.1). A keyed call reads its API key's saved rules profile ONCE, before
// rule activation (`ruleProfile`, `pre-trade-rule-profiles.ts`); keyless, x402 and internal calls never read one
// (`profileKeyOf`). The profile is the middle layer — defaults, then saved, then the call's own `rules`, key by key —
// and a saved rule is the caller's like a sent one (`isCallersRule`). A read that fails applies no saved rule and
// adds SAVED_RULES_UNAVAILABLE (adjust), so a keyed call is never GO without its saved rules. With no profile a
// keyed call decides exactly as before; `saved_rules` says whether one was applied.

import { z } from 'zod';
import {
  rankVenues,
  decide,
  venueRuleMetrics,
  PRE_TRADE_RULE_VERSION,
  type VenueMarketInput,
  type VenueEvaluation,
  type VenueRanking,
  type DecideResult,
  type RegimeRead,
  type PreTradeReason,
  type PreTradeDecision,
} from '../lib/pre-trade-decision.js';
import {
  parseRules,
  activeRules,
  activeLimit,
  evaluateRules,
  isCallersRule,
  type PreTradeRuleParam,
  type PreTradeRuleMetrics,
  type PreTradeRuleResult,
  type PreTradeRuleSource,
  type PreTradeRulesInput,
} from '../lib/pre-trade-rules.js';
import { getProfile, profileKeyOf, profileRefOf, type PreTradeRuleProfile } from '../lib/pre-trade-rule-profiles.js';
import { decisionVenueSet, staleFeeRows, takerFeeBps, VENUE_FEE_ROWS } from '../lib/venue-fees.js';
import {
  computePreTradeCalc,
  feeBpsFromPct,
  roundTripBps,
  sigma1hFromVolatilityRatio,
  type PreTradeCalc,
} from '../lib/pre-trade-calc.js';
import {
  marginTierAt,
  liquidationMaintenanceRate,
  type LiqBasis,
  type MarginTierRead,
} from '../lib/venue-margin-tiers.js';
import {
  getVenueUniverseState,
  getMergedFundingSnapshot,
  normalizeVenueFunding,
  type VenueUniverseState,
  type MergedFundingSnapshot,
} from '../lib/venue-market-state.js';
import { FUNDING_VENUE_META, FUNDING_ARB_FETCH_ADAPTERS } from '../lib/funding-venues.js';
import { effectiveLiquidityUsd, type ExchangeAsset } from '../lib/exchange-universe.js';
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
  mintCallLedgerId,
  receiptOf,
  verdictRecordFromResponse,
  type CallLedgerReceipt,
  type ServedVerdictSource,
} from '../lib/call-ledger.js';
import {
  PRE_TRADE_CHECK_PARAM_DECL,
  PRE_TRADE_SIDES,
  PRE_TRADE_ORDER_TYPES,
  REGIME_TIMEFRAMES,
  PUBLIC_VENUE_ENUM,
} from '../lib/tool-param-schema.js';
import {
  PRE_TRADE_CHECK_DESCRIPTION,
  PARAM_DESC_PRE_TRADE_COIN,
  PARAM_DESC_PRE_TRADE_SIDE,
  PARAM_DESC_PRE_TRADE_SIZE_USD,
  PARAM_DESC_PRE_TRADE_HOLD_HOURS,
  PARAM_DESC_PRE_TRADE_TIMEFRAME,
  PARAM_DESC_PRE_TRADE_EXCHANGES,
  PARAM_DESC_PRE_TRADE_LEVERAGE,
  PARAM_DESC_PRE_TRADE_STOP_PCT,
  PARAM_DESC_PRE_TRADE_TARGET_PCT,
  PARAM_DESC_PRE_TRADE_EQUITY_USD,
  PARAM_DESC_PRE_TRADE_ORDER_TYPE,
  PARAM_DESC_PRE_TRADE_RULES,
  PRE_TRADE_RULE_PARAM_DESC,
} from '../tool-descriptions.js';
import type { AlgoVaultMeta, ExchangeId, LicenseInfo, VenueStatus } from '../types.js';

export const PRE_TRADE_CHECK_TOOL = 'pre_trade_check' as const;

export { PRE_TRADE_CHECK_DESCRIPTION };

/** `data_unavailable` tells the caller when to come back — the universe cache's own refresh scale. */
export const PRE_TRADE_DATA_RETRY_AFTER_SECONDS = 30;

const D = PRE_TRADE_CHECK_PARAM_DECL;

/** One `rules` key's zod type, from its declared param (the bounds live once, in `PRE_TRADE_RULES`). */
function ruleZod(param: PreTradeRuleParam): z.ZodTypeAny {
  if (param.type === 'boolean') return z.boolean();
  let n = z.number();
  if (param.exclusiveMinimum !== undefined) n = n.gt(param.exclusiveMinimum);
  if (param.minimum !== undefined) n = n.min(param.minimum);
  return n.max(param.maximum);
}

/** `rules` — the first object param: every key optional and described, unknown keys refused (`.strict()`). */
const PRE_TRADE_RULES_ZOD = z.object(Object.fromEntries(
  (Object.entries(D.rules.properties) as [keyof typeof PRE_TRADE_RULE_PARAM_DESC, PreTradeRuleParam][])
    .map(([id, param]) => [id, ruleZod(param).optional().describe(PRE_TRADE_RULE_PARAM_DESC[id])]),
)).strict();

/**
 * Zod raw shape for `server.tool`. Every bound and default projects from `PRE_TRADE_CHECK_PARAM_DECL`
 * (tool-param-schema.ts). The enum ARRAYS are named imports — the arrays that declaration references —
 * because the REL-3 relational gate resolves each `z.enum(X)` through the file's named imports.
 * `exchanges` carries no `.default()`: absent means "every venue the tool prices". Uniqueness is not
 * expressible in Zod's JSON Schema; the handler refuses a repeat as `invalid_parameter`.
 */
export const PRE_TRADE_CHECK_SCHEMA = {
  coin: z.string().min(D.coin.minLength).max(D.coin.maxLength).describe(PARAM_DESC_PRE_TRADE_COIN),
  side: z.enum(PRE_TRADE_SIDES).describe(PARAM_DESC_PRE_TRADE_SIDE),
  sizeUsd: z.number().gt(D.sizeUsd.exclusiveMinimum).max(D.sizeUsd.maximum).describe(PARAM_DESC_PRE_TRADE_SIZE_USD),
  holdHours: z.number().min(D.holdHours.minimum).max(D.holdHours.maximum).default(D.holdHours.default)
    .describe(PARAM_DESC_PRE_TRADE_HOLD_HOURS),
  timeframe: z.enum(REGIME_TIMEFRAMES).default(D.timeframe.default).describe(PARAM_DESC_PRE_TRADE_TIMEFRAME),
  exchanges: z.array(z.enum(PUBLIC_VENUE_ENUM)).min(D.exchanges.minItems).max(D.exchanges.maxItems).optional()
    .describe(PARAM_DESC_PRE_TRADE_EXCHANGES),
  leverage: z.number().min(D.leverage.minimum).max(D.leverage.maximum).optional().describe(PARAM_DESC_PRE_TRADE_LEVERAGE),
  stopPct: z.number().min(D.stopPct.minimum).max(D.stopPct.maximum).optional().describe(PARAM_DESC_PRE_TRADE_STOP_PCT),
  targetPct: z.number().min(D.targetPct.minimum).max(D.targetPct.maximum).optional().describe(PARAM_DESC_PRE_TRADE_TARGET_PCT),
  equityUsd: z.number().gt(D.equityUsd.exclusiveMinimum).max(D.equityUsd.maximum).optional().describe(PARAM_DESC_PRE_TRADE_EQUITY_USD),
  orderType: z.enum(PRE_TRADE_ORDER_TYPES).default(D.orderType.default).describe(PARAM_DESC_PRE_TRADE_ORDER_TYPE),
  rules: PRE_TRADE_RULES_ZOD.optional().describe(PARAM_DESC_PRE_TRADE_RULES),
};

/** What the handler accepts. Loosely typed on purpose: it re-validates, so every channel gets one contract. */
export interface PreTradeCheckParams {
  coin: string;
  side: string;
  sizeUsd: number;
  holdHours?: number;
  timeframe?: string;
  exchanges?: readonly string[];
  /** V2 inputs — each optional; null is read as absent. */
  leverage?: number | null;
  stopPct?: number | null;
  targetPct?: number | null;
  equityUsd?: number | null;
  orderType?: string;
  /** The caller's own rules, each key optional (`pre-trade-rules.ts`); re-validated here. */
  rules?: unknown;
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
  maker_fee_bps: number | null;
  entry_fee_bps: number | null;
  round_trip_bps: number | null;
  maintenance_rate: number | null;
  liq_distance_pct: number | null;
  liq_basis: LiqBasis;
  /** Your rules on this venue: fail if any fails, else not_evaluated if any could not be checked, else pass; null with no rule of yours or off the candidates. */
  your_rules: PreTradeRuleOutcome | null;
}

type PreTradeRuleOutcome = PreTradeRuleResult['result'];

/** One active rule on the decision venue. */
export interface PreTradeRuleRow {
  id: string;
  source: PreTradeRuleSource;
  limit: number | boolean;
  value: number | boolean | string | null;
  result: PreTradeRuleOutcome;
  detail: string;
}

/** The v2 inputs as the handler read them (`null` = not sent). Echoed so a caller sees what was checked. */
export interface PreTradeInputsEcho {
  leverage: number | null;
  stop_pct: number | null;
  target_pct: number | null;
  equity_usd: number | null;
  order_type: 'market' | 'limit';
}

export interface PreTradeCheckResponse {
  coin: string;
  side: string;
  size_usd: number;
  hold_hours: number;
  timeframe: string;
  inputs: PreTradeInputsEcho;
  decision: PreTradeDecision;
  reasons: PreTradeReason[];
  /** Every active rule on the decision venue, in table order. */
  rules: PreTradeRuleRow[];
  rules_summary: { passed: number; failed: number; not_evaluated: number };
  /** V2.1: whether the API key's saved profile was applied, and when it was last saved (null when not applied). */
  saved_rules: { applied: boolean; updated_at: string | null };
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
  /** The decision venue's figures; each null when an input it needs is absent. */
  calc: PreTradeCalc;
  underlying_session: string | null;
  venues: PreTradeVenueRow[];
  assumptions: {
    funding: string;
    fees: string;
    size_guard_pct_of_24h_volume: number;
    volatility: string;
    liquidation: string;
    break_even: string;
  };
  fee_table_verified_at: string;
  rule_version: number;
  as_of: string;
  /**
   * DECISION-CALL-V2-W5: the call-ledger receipt — `{id, leaf, verify}` — on every LOGGED check (served,
   * billed, non-internal), absent otherwise. `leaf` commits this response's verdict (call-ledger.ts).
   */
  ledger?: CallLedgerReceipt;
  _algovault: AlgoVaultMeta;
}

export type PreTradeCheckRefusal =
  | { error: 'invalid_parameter'; code: 'invalid_parameter'; param: string; message: string; suggested_action: string; _algovault: PreTradeIdentity }
  | { error: 'venue_not_supported'; code: 'venue_not_supported'; requested: string[]; supported_venues: string[]; message: string; suggested_action: string; _algovault: PreTradeIdentity }
  | { error: 'data_unavailable'; code: 'data_unavailable'; retry_after_seconds: number; message: string; suggested_action: string; _algovault: PreTradeIdentity }
  | { error: 'coin_not_listed'; code: 'coin_not_listed'; coin: string; supported_venues: string[]; message: string; suggested_action: string; _algovault: PreTradeIdentity };

/**
 * What the handler knows about a served call that the wire does not carry — for the internal check log
 * (`pre-trade-check-log.ts`, DECISION-CALL-V2-W1 CH3), never served: the decision venue's reference price
 * (`refPrice`: the top-of-book mid, else the mark), the price its tier read converted the notional at.
 */
export interface PreTradeCheckFacts {
  refMidPx: number | null;
}

/** The handler's outcome. `status` is the HTTP-equivalent status of a refusal, for the pipeline. */
export type PreTradeCheckOutcome =
  | { kind: 'ok'; response: PreTradeCheckResponse; facts: PreTradeCheckFacts }
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
  /** The venue's published maintenance rate at the notional (`venue-margin-tiers.ts`). Called ONLY when `leverage` is sent. */
  marginTierAt: (exchange: string, coin: string, notionalUsd: number, refPx: number | null) => Promise<MarginTierRead>;
  /**
   * The API key's saved rules profile, or null when it has none (`pre-trade-rule-profiles.ts`). Called ONLY for a
   * keyed call, once, before rule activation. A throw or a rejection is SAVED_RULES_UNAVAILABLE, never a GO.
   */
  ruleProfile: (licenseKey: string) => Promise<PreTradeRuleProfile | null>;
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
  marginTierAt,
  // The store is keyed by the pseudonym, so the raw key stops here.
  ruleProfile: (licenseKey) => getProfile(profileRefOf(licenseKey)),
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
  leverage: number | null;
  stopPct: number | null;
  targetPct: number | null;
  equityUsd: number | null;
  orderType: 'market' | 'limit';
  rules: PreTradeRulesInput;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** What to do about a `rules` refusal, by what was wrong with it. */
const RULES_ACTION: Readonly<Record<'not_object' | 'unknown_key' | 'bad_value', string>> = {
  not_object: 'Pass rules as an object of rule keys, or omit it.',
  unknown_key: `Use only these rule keys: ${Object.keys(D.rules.properties).join(', ')}.`,
  bad_value: "Pass a value within the rule's bounds, or omit the key.",
};

/** An optional v2 number: null and undefined are both "not sent". */
const sent = (x: unknown): unknown => (x === null ? undefined : x);

/** A bounded optional number: `undefined` → null; out of the declaration's bounds → false. */
function boundedOpt(x: unknown, lo: number, hi: number, loExclusive = false): number | null | false {
  const val = sent(x);
  if (val === undefined) return null;
  if (!isNum(val) || (loExclusive ? !(val > lo) : val < lo) || val > hi) return false;
  return val;
}

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
  const leverage = boundedOpt(p.leverage, D.leverage.minimum, D.leverage.maximum);
  if (leverage === false) {
    return { ok: false, param: 'leverage', message: `leverage must be between ${D.leverage.minimum} and ${D.leverage.maximum}.`, suggested_action: 'Pass the isolated leverage you will use, or omit leverage.' };
  }
  const stopPct = boundedOpt(p.stopPct, D.stopPct.minimum, D.stopPct.maximum);
  if (stopPct === false) {
    return { ok: false, param: 'stopPct', message: `stopPct must be between ${D.stopPct.minimum} and ${D.stopPct.maximum}.`, suggested_action: 'Pass your stop-loss distance from entry in percent, or omit stopPct.' };
  }
  const targetPct = boundedOpt(p.targetPct, D.targetPct.minimum, D.targetPct.maximum);
  if (targetPct === false) {
    return { ok: false, param: 'targetPct', message: `targetPct must be between ${D.targetPct.minimum} and ${D.targetPct.maximum}.`, suggested_action: 'Pass your target distance from entry in percent, or omit targetPct.' };
  }
  const equityUsd = boundedOpt(p.equityUsd, D.equityUsd.exclusiveMinimum, D.equityUsd.maximum, true);
  if (equityUsd === false) {
    return { ok: false, param: 'equityUsd', message: `equityUsd must be above ${D.equityUsd.exclusiveMinimum} and at most ${D.equityUsd.maximum.toLocaleString('en-US')}.`, suggested_action: 'Pass your account equity in USD, or omit equityUsd.' };
  }
  const orderType = sent(p.orderType) ?? D.orderType.default;
  if (!(PRE_TRADE_ORDER_TYPES as readonly unknown[]).includes(orderType)) {
    return { ok: false, param: 'orderType', message: `orderType must be one of: ${PRE_TRADE_ORDER_TYPES.join(', ')}.`, suggested_action: `Pass market or limit, or omit it for ${D.orderType.default}.` };
  }
  const rules = parseRules(p.rules);
  if (!rules.ok) {
    return { ok: false, param: rules.param, message: rules.message, suggested_action: RULES_ACTION[rules.kind] };
  }
  return {
    ok: true,
    params: {
      coin, side: p.side as 'long' | 'short', sizeUsd: p.sizeUsd, holdHours, timeframe: timeframe as RegimeScanTimeframe, exchanges,
      leverage, stopPct, targetPct, equityUsd, orderType: orderType as 'market' | 'limit', rules: rules.rules,
    },
  };
}

// ── The response: every key named ───────────────────────────────────────────────────────────────

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** The contract's assumptions block — stated on every response, never implied. The size guard is the ACTIVE limit, per call. */
const ASSUMPTIONS = Object.freeze({
  funding: 'current rate held for the whole hold',
  fees: 'base-tier taker, no discounts; per-pair exceptions not modelled',
  volatility: '1h sigma = ATR(14)/price of the newest fresh 1h snapshot / sqrt(8/pi), scaled by sqrt(hold hours)',
  liquidation: "isolated, at the maintenance rate of each venue's public tier for the order notional (a band edge takes the higher rate; Bitget adds its taker fee), deduction ignored so the distance is never overstated",
  break_even: 'accuracy needed = 50% + round trip / (2 x expected move over the hold); win rate needed = (1 + round trip / stop) / (1 + target / stop)',
});

/** One venue's v2 figures, parallel to `ranking.venues`. */
export interface PreTradeVenueCosts {
  makerFeeBps: number | null;
  entryFeeBps: number | null;
  roundTripBps: number | null;
  /** The m the liquidation formula used (Bitget's includes its taker fee); null without a public tier rate. */
  maintenanceRate: number | null;
  liqDistancePct: number | null;
  liqBasis: LiqBasis;
}

export interface PreTradeResponseInput {
  coin: string;
  side: string;
  sizeUsd: number;
  holdHours: number;
  timeframe: string;
  nowMs: number;
  inputs: PreTradeInputsEcho;
  ranking: VenueRanking;
  decided: DecideResult;
  /** The active rules on the decision venue (or on no venue), in table order — what `decide` judged. */
  rules: readonly PreTradeRuleResult[];
  /** Whether the key's saved profile was applied, and its last save. */
  savedRules: { applied: boolean; updatedAt: string | null };
  /** The active `maxSizePctOf24hVolume`, a percent. */
  sizeGuardPct: number;
  regime: RegimeRead | null;
  calc: PreTradeCalc;
  venueCosts: readonly PreTradeVenueCosts[];
  /** Your rules per venue, parallel to `ranking.venues`. */
  yourRules: readonly (PreTradeRuleOutcome | null)[];
  underlyingSession: string | null;
  feeTableVerifiedAt: string;
}

/**
 * The call-ledger receipt of a response body AS BUILT — the very object that is served (DECISION-CALL-V2-W5).
 * A fresh id, and the verdict leaf of the body's own values. NEVER THROWS: a record it cannot hash (a
 * non-finite figure) serves the call without a receipt, and a call without one is never logged, so the
 * health canary's parity leg counts it.
 */
function mintReceipt(body: ServedVerdictSource): CallLedgerReceipt | null {
  try {
    return receiptOf(verdictRecordFromResponse(body, mintCallLedgerId()));
  } catch (e) {
    console.error(`[pre-trade-check] served without a ledger receipt: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    return null;
  }
}

/**
 * EXPORTED allow-list formatter. Every public key is copied by name from the engine's typed output —
 * never a spread — so a field added to the engine cannot reach the wire without being named here and
 * in the shape snapshot.
 *
 * THE RECEIPT (DECISION-CALL-V2-W5): this builder runs only on the served path, after `trackCall` billed the
 * call, so `license.tier !== 'internal'` here IS the check log's predicate (served, billed, non-internal) —
 * decided once. A logged call gets `ledger` (minted from the built body, appended after `as_of`); the pipeline
 * logs a call exactly when its response carries one. A refusal never reaches this function.
 */
export function toPreTradeCheckResponse(a: PreTradeResponseInput, meta: AlgoVaultMeta, license: LicenseInfo): PreTradeCheckResponse {
  const { ranking, decided, calc: c } = a;
  const best = ranking.best;
  const t = decided.timing;
  const body: Omit<PreTradeCheckResponse, 'ledger' | '_algovault'> = {
    coin: a.coin,
    side: a.side,
    size_usd: a.sizeUsd,
    hold_hours: a.holdHours,
    timeframe: a.timeframe,
    inputs: {
      leverage: a.inputs.leverage,
      stop_pct: a.inputs.stop_pct,
      target_pct: a.inputs.target_pct,
      equity_usd: a.inputs.equity_usd,
      order_type: a.inputs.order_type,
    },
    decision: decided.decision,
    reasons: decided.reasons.map((r) => ({ code: r.code, severity: r.severity, detail: r.detail })),
    rules: a.rules.map((r) => ({ id: r.id, source: r.source, limit: r.limit, value: r.value, result: r.result, detail: r.detail })),
    rules_summary: {
      passed: a.rules.filter((r) => r.result === 'pass').length,
      failed: a.rules.filter((r) => r.result === 'fail').length,
      not_evaluated: a.rules.filter((r) => r.result === 'not_evaluated').length,
    },
    saved_rules: { applied: a.savedRules.applied, updated_at: a.savedRules.updatedAt },
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
    calc: {
      sigma_1h_pct: c.sigma_1h_pct,
      sigma_hold_pct: c.sigma_hold_pct,
      expected_move_pct: c.expected_move_pct,
      round_trip_bps: c.round_trip_bps,
      accuracy_needed_pct: c.accuracy_needed_pct,
      win_rate_needed_pct: c.win_rate_needed_pct,
      random_entry_target_first_pct: c.random_entry_target_first_pct,
      liq_distance_pct: c.liq_distance_pct,
      liq_distance_sigma: c.liq_distance_sigma,
      liq_before_stop: c.liq_before_stop,
      loss_at_stop_pct_equity: c.loss_at_stop_pct_equity,
      one_sigma_day_pct_equity: c.one_sigma_day_pct_equity,
    },
    underlying_session: a.underlyingSession,
    venues: ranking.venues.map((v, i) => ({
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
      maker_fee_bps: a.venueCosts[i].makerFeeBps,
      entry_fee_bps: a.venueCosts[i].entryFeeBps,
      round_trip_bps: a.venueCosts[i].roundTripBps,
      maintenance_rate: a.venueCosts[i].maintenanceRate,
      liq_distance_pct: a.venueCosts[i].liqDistancePct,
      liq_basis: a.venueCosts[i].liqBasis,
      your_rules: a.yourRules[i],
    })),
    assumptions: {
      funding: ASSUMPTIONS.funding,
      fees: ASSUMPTIONS.fees,
      size_guard_pct_of_24h_volume: a.sizeGuardPct,
      volatility: ASSUMPTIONS.volatility,
      liquidation: ASSUMPTIONS.liquidation,
      break_even: ASSUMPTIONS.break_even,
    },
    fee_table_verified_at: a.feeTableVerifiedAt,
    rule_version: PRE_TRADE_RULE_VERSION,
    as_of: new Date(a.nowMs).toISOString(),
  };
  const ledger = license.tier === 'internal' ? null : mintReceipt(body);
  // Appended in order — `ledger` (when minted), then `_algovault` last — onto the body the receipt was minted
  // from; never a spread of engine output.
  return Object.assign(body, ledger === null ? {} : { ledger }, { _algovault: withAuthState(meta, license) });
}

// ── Gathering ───────────────────────────────────────────────────────────────────────────────────

/** The funding adapters to SKIP: the retired, plus every adapter that feeds no venue in `venues`. */
function fundingSkipSet(venues: readonly string[], retired: ReadonlySet<string>): Set<string> {
  const needed = new Set<string>(
    Object.values(FUNDING_VENUE_META).filter((m) => venues.includes(m.exchangeId)).map((m) => m.fetchedVia),
  );
  return new Set<string>([...retired, ...FUNDING_ARB_FETCH_ADAPTERS.filter((a) => !needed.has(a))]);
}

/** The coin's row in a venue's universe; undefined when not listed or the universe is unreadable. */
function coinRow(universe: VenueUniverseState, coin: string): ExchangeAsset | undefined {
  return universe.failed ? undefined : universe.rows.find((r) => r.coin === coin);
}

/** The venue's reference price for the coin: the top-of-book mid when both quotes are usable, else the mark. */
function refPrice(row: ExchangeAsset | undefined): number | null {
  if (!row) return null;
  const { bidPx, askPx, markPx } = row;
  if (isNum(bidPx) && isNum(askPx) && bidPx > 0 && askPx >= bidPx) return (bidPx + askPx) / 2;
  return isNum(markPx) && markPx > 0 ? markPx : null;
}

/** One venue's market input for the coin, from the shared universe + funding snapshot. */
function venueInput(exchange: ExchangeId, coin: string, universe: VenueUniverseState, funding: MergedFundingSnapshot): VenueMarketInput {
  const row = coinRow(universe, coin);
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

/** The timeframe sigma is read at: ATR(14)/price of a 1h bar, whatever regime timeframe the caller asked. */
const SIGMA_TIMEFRAME: RegimeScanTimeframe = '1h';

interface FreshSnapshot {
  row: RegimeSnapshotRow;
  barCloseMs: number;
  venue: string;
}

/**
 * The newest servable FRESH snapshot row for the coin at `timeframe`: the `first` venue's (the cheapest), else
 * the next sampled venue's. The regime and sigma reads both walk this way; one rule, `regimeGenerationFreshness`.
 */
async function freshSnapshotRow(
  deps: PreTradeCheckDeps, sampled: readonly string[], coin: string, timeframe: RegimeScanTimeframe, nowMs: number, first: string | null,
): Promise<FreshSnapshot | null> {
  const order = first && sampled.includes(first) ? [first, ...sampled.filter((v) => v !== first)] : [...sampled];
  for (const venue of order) {
    const gen = await deps.latestServableGeneration(venue, timeframe);
    if (!gen || !regimeGenerationFreshness(gen, timeframe, nowMs).fresh) continue;
    const row = await deps.readGenerationRow(venue, timeframe, gen.bar_close_ms, coin);
    if (row) return { row, barCloseMs: gen.bar_close_ms, venue };
  }
  return null;
}

/** One venue's v2 figures and the calculator output they come from — one derivation per venue. */
function venueFigures(
  ev: VenueEvaluation, tier: MarginTierRead | null, p: Normalized, sigma1h: number | null,
): { costs: PreTradeVenueCosts; calc: PreTradeCalc } {
  const feeRow = VENUE_FEE_ROWS.find((r) => r.exchange === ev.exchange);
  const makerFeeBps = feeRow ? feeBpsFromPct(feeRow.makerPct) : null;
  const entryFeeBps = p.orderType === 'limit' ? makerFeeBps : ev.takerFeeBps;
  const rt = roundTripBps({ entryFeeBps, exitFeeBps: ev.takerFeeBps, spreadBps: ev.spreadBasis === 'top_of_book' ? ev.spreadBps : null });
  const maintenanceRate = tier?.rate != null ? liquidationMaintenanceRate(ev.exchange, tier.rate) : null;
  const calc = computePreTradeCalc({
    side: p.side, sizeUsd: p.sizeUsd, holdHours: p.holdHours, sigma1h, roundTripBps: rt,
    leverage: p.leverage, maintenanceRate, stopPct: p.stopPct, targetPct: p.targetPct, equityUsd: p.equityUsd,
  });
  return {
    calc,
    costs: {
      makerFeeBps,
      entryFeeBps,
      roundTripBps: calc.round_trip_bps,
      maintenanceRate,
      liqDistancePct: calc.liq_distance_pct,
      liqBasis: p.leverage === null ? 'leverage_not_given' : (tier?.basis ?? 'tier_unavailable'),
    },
  };
}

/**
 * What the rules read on one venue (or, with `ev` null, on none): the engine's funding, size and regime
 * metrics (`venueRuleMetrics`, their one derivation) plus that venue's calculator figures.
 */
function ruleMetrics(
  ev: VenueEvaluation | null, calc: PreTradeCalc, liqBasis: LiqBasis | null, p: Normalized, regime: RegimeRead | null,
): PreTradeRuleMetrics {
  const engine = venueRuleMetrics(ev, { side: p.side, sizeUsd: p.sizeUsd, regime });
  return {
    exchange: engine.exchange,
    side: engine.side,
    sizeUsd: engine.sizeUsd,
    leverage: p.leverage,
    stop_pct: p.stopPct,
    equity_usd: p.equityUsd,
    liq_distance_pct: calc.liq_distance_pct,
    liq_before_stop: calc.liq_before_stop,
    liq_distance_sigma: calc.liq_distance_sigma,
    loss_at_stop_pct_equity: calc.loss_at_stop_pct_equity,
    one_sigma_day_pct_equity: calc.one_sigma_day_pct_equity,
    round_trip_bps: calc.round_trip_bps,
    accuracy_needed_pct: calc.accuracy_needed_pct,
    funding_cost_bps: engine.funding_cost_bps,
    size_pct_of_24h_volume: engine.size_pct_of_24h_volume,
    capacity_usd: engine.capacity_usd,
    regime: engine.regime,
    sigma_available: calc.sigma_1h_pct !== null,
    liq_basis: liqBasis,
  };
}

/** Your rules — sent or saved — on one venue: fail if any fails, else not_evaluated if any could not be checked, else pass; null with none. */
function yourRulesOutcome(rules: readonly PreTradeRuleResult[] | null): PreTradeRuleOutcome | null {
  const yours = rules ? rules.filter((r) => isCallersRule(r.source)) : [];
  if (yours.length === 0) return null;
  if (yours.some((r) => r.result === 'fail')) return 'fail';
  return yours.some((r) => r.result === 'not_evaluated') ? 'not_evaluated' : 'pass';
}

/**
 * The decision-venue key, compared before v1's order (contract § Rules): no failed rule of yours (a saved one
 * counts as yours, § v2.1), then the fewest rules not evaluated, then — so a sent leverage picks a venue that
 * publishes its tiers — a liquidation figure. With no v2 input every candidate's key is equal, so the venue is v1's.
 */
function decisionKey(rules: readonly PreTradeRuleResult[], liqDistancePct: number | null, leverageSent: boolean): number[] {
  return [
    rules.some((r) => isCallersRule(r.source) && r.result === 'fail') ? 1 : 0,
    rules.filter((r) => r.result === 'not_evaluated').length,
    leverageSent && liqDistancePct === null ? 1 : 0,
  ];
}

/** What the key's saved profile gives a call: the middle layer's rules, and what `saved_rules` reports. */
interface SavedRulesRead {
  rules: PreTradeRulesInput;
  applied: boolean;
  updatedAt: string | null;
  /** True when a keyed call's profile could not be read: SAVED_RULES_UNAVAILABLE. */
  unavailable: boolean;
}

const noSavedRules = (unavailable = false): SavedRulesRead => ({ rules: {}, applied: false, updatedAt: null, unavailable });

/**
 * The call's saved rules: ONE read for a keyed call (`profileKeyOf`), none for any other. A read that throws or
 * rejects — no hash key, a database fault, a stored value that no longer parses — applies nothing and is
 * `unavailable`; it is logged without the key.
 */
async function readSavedRules(deps: PreTradeCheckDeps, license: LicenseInfo): Promise<SavedRulesRead> {
  const key = profileKeyOf(license);
  if (key === null) return noSavedRules();
  try {
    const profile = await deps.ruleProfile(key);
    return profile ? { rules: profile.rules, applied: true, updatedAt: profile.updatedAt, unavailable: false } : noSavedRules();
  } catch (e) {
    const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[pre_trade_check] saved rules unreadable, not applied: ${why.slice(0, 200)}`);
    return noSavedRules(true);
  }
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

  // The key's saved rules (one read, keyed calls only) → the three layers → rank at the active size limit →
  // regime, sigma and (only when leverage is sent) tier tables, side by side → every active rule on every
  // candidate → the decision venue → session → decide.
  const { leverage, stopPct, targetPct, equityUsd, orderType } = v.params;
  const saved = await readSavedRules(deps, license);
  const active = activeRules(v.params.rules, saved.rules);
  const sizeGuardPct = activeLimit(active, 'maxSizePctOf24hVolume');
  const rankInput = { venues: inputs, side, sizeUsd, holdHours, nowMs, sizeMaxFraction: sizeGuardPct / 100 };
  const cheapest = rankVenues(rankInput);
  const refPxs = venues.map((_, i) => refPrice(coinRow(universes[i], coin)));
  const sampled = await deps.sampledRegimeVenues();
  const first = cheapest.best?.exchange ?? null;
  const regimeRead = freshSnapshotRow(deps, sampled, coin, timeframe, nowMs, first);
  // v2's own second read. A rejection costs the volatility figures (sigma null; VOLATILITY_UNAVAILABLE when a v2 input
  // was sent), never the served call — like the tier reads below. The regime read is v1's and keeps v1's failure
  // (DECISION-CALL-V2-AUDIT-W1 R3).
  const sigmaRead: Promise<FreshSnapshot | null> = timeframe === SIGMA_TIMEFRAME
    ? regimeRead
    : freshSnapshotRow(deps, sampled, coin, SIGMA_TIMEFRAME, nowMs, first).catch((): null => null);
  const tierReads = Promise.all(cheapest.venues.map((ev, i): Promise<MarginTierRead | null> => (
    leverage !== null && ev.listed === true
      ? deps.marginTierAt(ev.exchange, coin, sizeUsd, refPxs[i]).catch((): MarginTierRead => ({ rate: null, basis: 'tier_unavailable' }))
      : Promise.resolve(null)
  )));
  const [regimeSnap, sigmaSnap, tiers] = await Promise.all([regimeRead, sigmaRead, tierReads]);
  const regime: RegimeRead | null = regimeSnap
    ? { label: regimeSnap.row.regime, confidence: regimeSnap.row.confidence, timeframe, asOfMs: regimeSnap.barCloseMs, sourceExchange: regimeSnap.venue }
    : null;
  const sigma1h = sigma1hFromVolatilityRatio(sigmaSnap?.row.volatility_ratio ?? null);
  const figures = cheapest.venues.map((ev, i) => venueFigures(ev, tiers[i], v.params, sigma1h));
  const candidates = new Set(cheapest.candidates);
  const venueRules = cheapest.venues.map((ev, i) => (
    candidates.has(ev) ? evaluateRules(active, ruleMetrics(ev, figures[i].calc, figures[i].costs.liqBasis, v.params, regime)) : null
  ));

  // The decision venue: v1's order behind the rules' key. `rankVenues` is pure, so the re-rank evaluates every
  // venue exactly as `cheapest` did (same index order) and only `best`, its size limit and the split can move.
  const keys = new Map(cheapest.venues.map((ev, i) => [
    ev.exchange, venueRules[i] ? decisionKey(venueRules[i], figures[i].costs.liqDistancePct, leverage !== null) : [],
  ]));
  const ranking = rankVenues({ ...rankInput, preference: (ev) => keys.get(ev.exchange) ?? [] });
  const best = ranking.best;
  const decisionIdx = best ? ranking.venues.indexOf(best) : -1;
  const calc = decisionIdx >= 0
    ? figures[decisionIdx].calc
    : computePreTradeCalc({ side, sizeUsd, holdHours, sigma1h, roundTripBps: null, leverage, maintenanceRate: null, stopPct, targetPct, equityUsd });
  const rules = decisionIdx >= 0
    ? (venueRules[decisionIdx] as PreTradeRuleResult[])
    : evaluateRules(active, ruleMetrics(null, calc, null, v.params, regime));
  // Saved rules count as rules the call carries: they are applied as if sent, layer under layer.
  const v2Sent = leverage !== null || stopPct !== null || targetPct !== null || equityUsd !== null
    || orderType === 'limit' || Object.keys(v.params.rules).length > 0 || Object.keys(saved.rules).length > 0;
  const decisionCosts = decisionIdx >= 0 ? figures[decisionIdx].costs : null;

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
    rules,
    sizeMaxPct: sizeGuardPct,
    volatilityUnavailable: v2Sent && calc.sigma_1h_pct === null,
    liquidationUnavailable: best && decisionCosts && leverage !== null && decisionCosts.liqDistancePct === null
      ? { exchange: best.exchange, basis: decisionCosts.liqBasis }
      : null,
    savedRulesUnavailable: saved.unavailable,
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
    facts: { refMidPx: decisionIdx >= 0 ? refPxs[decisionIdx] : null },
    response: toPreTradeCheckResponse(
      {
        coin, side, sizeUsd, holdHours, timeframe, nowMs,
        inputs: { leverage, stop_pct: stopPct, target_pct: targetPct, equity_usd: equityUsd, order_type: orderType },
        ranking, decided, rules, savedRules: { applied: saved.applied, updatedAt: saved.updatedAt }, sizeGuardPct, regime, calc,
        venueCosts: figures.map((f) => f.costs), yourRules: venueRules.map(yourRulesOutcome),
        underlyingSession: session, feeTableVerifiedAt: oldestVerified,
      },
      meta,
      license,
    ),
  };
}
