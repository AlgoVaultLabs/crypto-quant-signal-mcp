// ── scan_trade_calls tool wrapper (SCAN-TRADE-CALLS-W1 C3) ──
//
// Thin quota+envelope layer over the pure `scanTradeCalls` compute engine
// (src/lib/trade-call-scanner.ts). Mirrors the scan_funding_arb structure:
// the index.ts `server.tool` handler stays minimal (logRequest + analytics +
// error catch) and delegates the business logic here, which keeps this unit
// importable by tests without triggering index.ts's startHttp/startStdio
// bootstrap.
//
// Responsibilities the scanner module deliberately does NOT have:
//   • checkQuota entry gate (free-tier exhaustion → getQuotaExhaustedMessage)
//   • charge the batch via the C1 multi-unit seam: trackCall(license, units)
//     where units = max(1, calls RETURNED) — every returned verdict counts, HOLD
//     included (R-G). Charging only non-HOLD would make a scan the free-HOLD
//     loophole that re-opens everything R-A closes.
//   • assemble the `_algovault` envelope (tool/version/quota/track-record ptr)
//
// Result shaping stays allow-listed: the response is the scanner's result
// (calls[] = ScanCallItem only) plus `_algovault`. No outcome_* ever.

import { z } from 'zod';
import {
  scanTradeCalls,
  type ScanTradeCallsParams,
  type ScanTradeCallsResult,
  type ScanCallItem,
} from '../lib/trade-call-scanner.js';
import { checkQuota, trackCall, getRequestSessionId, requestClientProfile } from '../lib/license.js';
import { assertVenueNotRetired } from '../lib/venue-store.js';
import { TimeframeUnservedError, buildTimeframeUnservedPayload } from '../lib/errors.js';
import { isTimeframeServed, servedTimeframes } from '../lib/tf-support.js';
import { formatScanReceipts, type ScanReceipts } from '../lib/receipts.js';
import { getReceiptTrackRecord } from '../lib/receipts-track-record.js';
import { PKG_VERSION } from '../lib/pkg-version.js';
// REFERRAL-INPRODUCT-NUDGE-W1: the limit moment (quota-exhausted) + trigger (b)
// multi-hit-scan referral arm. Numbers from the referral SoT; ≤1 aha referral/
// session shared with get_trade_call via the single-source aha-event store.
import { referralCodeForKey } from '../lib/referral-store.js';
import { buildReferralHint, buildAhaReferral, type ReferralHint } from '../lib/nudge-copy.js';
import { shouldShowAhaReferral } from '../lib/aha-event.js';
import { getTrackRecord } from '../lib/track-record-snapshot.js';
import { resolveRankBy, rankByTokens } from '../lib/rank-constants.js';
// DOCS-PARAM-SCHEMA-PROJECTION-W1: the scan lens enums + their defaults are declared once and
// projected into both this served schema and the /docs parameter table.
import {
  OI_CHANGE_WINDOWS, OI_BASES, SCAN_TIMEFRAME_DEFAULT, SCAN_EXCHANGE_DEFAULT,
  SCAN_OI_CHANGE_WINDOW_DEFAULT, SCAN_OI_BASIS_DEFAULT,
} from '../lib/tool-param-schema.js';
// SCAN-MARKET-REGIMES-W1-V2 CH2: the quota wall (incl. its x402 branch, FUNNEL-FIX-AGENT-X402-
// NUDGE-W1 Q4) and the served quota block are built in scan-shared.ts, shared with
// scan_market_regimes.
import { buildScanQuotaWall, buildScanQuotaState } from '../lib/scan-shared.js';
// AUTH-THREE-STATE-W1 CH2: this tool builds its `_algovault` BY HAND at three sites, which is
// exactly why the last envelope wave left it behind (see the note at the quota block below). All
// three are stamped here so the straggler does not recur.
import { withAuthState } from '../lib/tier-warning.js';
import {
  SCAN_TRADE_CALLS_DESCRIPTION,
  PARAM_DESC_SCAN_TOP_N,
  PARAM_DESC_SCAN_TIMEFRAME,
  PARAM_DESC_SCAN_EXCHANGE,
  PARAM_DESC_SCAN_MIN_CONFIDENCE,
  PARAM_DESC_SCAN_INCLUDE_HOLDS,
  PARAM_DESC_SCAN_LIMIT,
  PARAM_DESC_SCAN_RANK_BY,
  PARAM_DESC_SCAN_INCLUDE_REASONING,
  PARAM_DESC_SCAN_OI_CHANGE_WINDOW,
  PARAM_DESC_SCAN_OI_BASIS,
  PARAM_DESC_SCAN_MIN_LIQUIDITY_USD,
} from '../tool-descriptions.js';
import type { LicenseInfo, QuotaState, SuggestedX402 } from '../types.js';
import { PROMOTED_VENUE_IDS, type PromotedVenueId } from '../lib/capabilities.js';
import { compatibleWith } from '../lib/primitive-projection.js';

export { SCAN_TRADE_CALLS_DESCRIPTION };

/**
 * Zod raw shape for `server.tool`. Exported so the C3 canary can validate bounds without importing
 * index.ts. OPS-SCAN-UNIVERSE-EXPAND-W1: the `exchange` enum is DERIVED from EXCHANGES (all 12
 * promoted venues), NOT a hand-maintained 5-literal and NOT the 17-value get_trade_call enum
 * (getExchangeTopAssetsWithVolume now covers the 12 promoted + fail-softs, never throws).
 */
export const SCAN_TRADE_CALLS_SCHEMA = {
  topN: z.number().int().min(1).max(100).default(20).describe(PARAM_DESC_SCAN_TOP_N),
  timeframe: z
    .enum(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'])
    .default(SCAN_TIMEFRAME_DEFAULT)
    .describe(PARAM_DESC_SCAN_TIMEFRAME),
  exchange: z.enum(PROMOTED_VENUE_IDS as [PromotedVenueId, ...PromotedVenueId[]]).default(SCAN_EXCHANGE_DEFAULT).describe(PARAM_DESC_SCAN_EXCHANGE),
  minConfidence: z.number().min(0).max(100).optional().describe(PARAM_DESC_SCAN_MIN_CONFIDENCE),
  includeHolds: z.boolean().default(false).describe(PARAM_DESC_SCAN_INCLUDE_HOLDS),
  limit: z.number().int().min(1).max(100).default(10).describe(PARAM_DESC_SCAN_LIMIT),
  // SCAN-RANKBY-W1: universe-selection lens (param, not a tool — tools/list stays 9).
  // Raw string so the bot can forward an alias (nfr/pfr/…) verbatim; the MCP resolves
  // it via resolveRankBy (the single alias map). Default 'oi' ⇒ byte-identical output.
  rankBy: z
    // SEC-45 (OPS-AUDIT-REMEDIATION-LOW-W1): the only unbounded z.string() on the MCP tool
    // surface. An invalid value is reflected back in the structured rejection, so an unbounded
    // string is an unbounded reflection. 32 chars clears the longest canonical token plus alias
    // headroom; resolveRankBy still owns which tokens are actually valid.
    .string()
    .max(32)
    .optional()
    .default('oi').describe(PARAM_DESC_SCAN_RANK_BY),
  // SCAN-DIGEST-MCP-PARITY-W1 CH1: opt-in per-call enrichment. Default false ⇒ bare
  // output, byte-identical to today. Mirrors get_trade_call's param name (NB:
  // get_trade_call defaults TRUE; scan defaults FALSE — bare back-compat is the firewall).
  includeReasoning: z.boolean().default(false).describe(PARAM_DESC_SCAN_INCLUDE_REASONING),
  // SCAN-RANKBY-REFINEMENTS-W1 CH1: OI-delta window for the oi_change lens. z.enum
  // rejects an invalid value at the MCP boundary (the same default-deny as exchange/
  // timeframe); default '24h' ⇒ byte-identical when omitted. Ignored by other lenses.
  oiChangeWindow: z.enum(OI_CHANGE_WINDOWS).default(SCAN_OI_CHANGE_WINDOW_DEFAULT).describe(PARAM_DESC_SCAN_OI_CHANGE_WINDOW),
  // SCAN-RANKBY-REFINEMENTS-W1 CH3: OI-delta basis for the oi_change lens. z.enum rejects an
  // invalid value at the MCP boundary; default 'notional' ⇒ byte-identical. Ignored by other lenses.
  oiBasis: z.enum(OI_BASES).default(SCAN_OI_BASIS_DEFAULT).describe(PARAM_DESC_SCAN_OI_BASIS),
  // FIX-CONVICTION-CALL-POSTS-W1: optional USD liquidity floor on the scan UNIVERSE.
  // `.optional()` with NO default — absent ⇒ no floor ⇒ byte-identical output, the same
  // firewall `minConfidence` uses. It lives here rather than in a consumer because the
  // per-call payload carries no liquidity field at all, so a caller physically cannot
  // apply it downstream; gating server-side is also what lets every surface share ONE
  // derivation of the floor instead of each re-implementing it.
  minLiquidityUsd: z.number().min(0).optional().describe(PARAM_DESC_SCAN_MIN_LIQUIDITY_USD),
};

export interface ScanAlgovaultMeta {
  tool: 'scan_trade_calls';
  version: string;
  /**
   * `resets_at` added additively by OPS-QUOTA-EXHAUSTION-NOTICE-W1; `daily` + `binding` by
   * OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH2 (instance 10).
   *
   * This is now `QuotaState` itself rather than a hand-copied structural twin. The twin is how
   * this envelope fell behind in the first place: the parent wave widened `QuotaState` with the
   * daily pair and every consumer projecting from the shared type inherited it, while these two
   * local re-declarations silently did not.
   */
  quota: QuotaState;
  compatible_with: string[];
  signal_performance: string;
  session_id: string | null;
  /** REFERRAL-INPRODUCT-NUDGE-W1 trigger (b): the human multi-hit-scan referral
   *  line for a KEYED user (≤1 aha referral/session). Additive, optional. */
  upgrade_hint?: string;
  /** REFERRAL-INPRODUCT-NUDGE-W1: additive, allow-listed structured referral hint
   *  (agent-relayable). NO outcome_*. */
  referral_hint?: ReferralHint;
}

export interface ScanTradeCallsResponse extends ScanTradeCallsResult {
  _algovault: ScanAlgovaultMeta;
  /**
   * P0 VERDICT-WITH-RECEIPTS-W1: envelope-shared inline proof. Each `calls[]` row
   * already carries its own verdict (`call`) + conviction (`confidence`) + regime;
   * the track record + verify link + disclaimer are shared ONCE here (the
   * lower-token shape — a row + this envelope stands alone in a screenshot).
   * `track_record` is OMITTED fail-open when the source is unavailable.
   */
  _receipts: ScanReceipts;
}

export interface ScanQuotaExhaustedResponse {
  error: 'quota_exhausted';
  /**
   * OPS-QUOTA-EXHAUSTION-NOTICE-W1: aligned to the ONE code every other surface emits. It was
   * lowercase `tier_limit_reached` here and `TIER_LIMIT_REACHED` everywhere else, so an agent
   * branching on the code needed two branches for one event. `error` keeps its original
   * lowercase `quota_exhausted` value, so a consumer matching on THAT is unaffected.
   */
  code: 'TIER_LIMIT_REACHED';
  message: string;
  /** `resets_at` added (additive) — the pre-wave shape carried no reset instant at all. */
  /** `QuotaState` — see the note on `ScanAlgovaultMeta.quota`. Composite, never a flat twin. */
  quota: QuotaState;
  /** OPS-QUOTA-EXHAUSTION-NOTICE-W1 notice facts — additive, mirroring the TIER_LIMIT envelope. */
  usage_display: string;
  resets_at: string;
  retry_after_days: number;
  /**
   * OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH3 (instance 14, found by the LIVE CAPTURE).
   *
   * `quotaNoticeFacts` has always returned both of these and this hand-built envelope dropped them,
   * so an agent branching on `limit` got `'daily'` from get_trade_call / get_market_regime /
   * scan_funding_arb and `undefined` from THIS tool for the same wall — and got
   * `retry_after_days: 1` for a wall that lifts in 12 hours with no hours field to refine it.
   *
   * Neither of this wave's own checks could see it: check B scans for emitting primitives and this
   * envelope routes through the right one, and check A asserted the fields the registry DECLARED
   * this surface emits rather than the ones its siblings emit. It took a live daily-walled call.
   * That is precisely the class the standing live-capture requirement exists for.
   */
  limit: 'daily' | 'monthly';
  /** Present ONLY on a daily wall — absence is the signal that days is the right horizon. */
  retry_after_hours?: number;
  /** W4-R2 CH1: commerce fields (with `referral_hint`, `suggested_x402`) — absent for a restricted profile. */
  recommended_path?: 'subscription' | 'x402';
  suggested_action: string;
  /** REFERRAL-INPRODUCT-NUDGE-W1: the limit moment also carries the structured,
   *  allow-listed referral hint (`from: 'limit'`); the `message` leads with it. */
  referral_hint?: ReferralHint;
  /** FUNNEL-FIX-AGENT-X402-NUDGE-W1 (Q4): additive in-protocol x402 pay-per-call branch at the
   *  scan wall (/x402/scan_trade_calls is live). Omitted when X402_NUDGE_ENABLED is off / no rail. */
  suggested_x402?: SuggestedX402;
  _algovault: { tool: 'scan_trade_calls'; version: string; session_id: string | null };
}

/** SCAN-RANKBY-W1: structured rejection for an unrecognized `rankBy` lens token
 *  (CLAUDE.md structured-error LAW). Returned BEFORE any quota check, scan, or
 *  charge — an invalid lens is never billed. The bot pre-validates against
 *  /capabilities, so this backstops agent / x402 callers. */
export interface ScanInvalidRankResponse {
  error: 'invalid_rank_by';
  code: 'invalid_parameter';
  message: string;
  valid_lenses: string[];
  suggested_action: string;
  _algovault: { tool: 'scan_trade_calls'; version: string; session_id: string | null };
}

/** OPS-SERVED-CANDLE-TRUTH-W1 CH2: the venue does not serve the timeframe (OKX / BYBIT 8h). Returned UP FRONT —
 *  before quota, scan or charge — so N cells never each error on it. The same `timeframe_unserved` code and field
 *  names as get_trade_call (buildTimeframeUnservedPayload) and scan_market_regimes. */
export interface ScanTimeframeUnservedResponse extends ReturnType<typeof buildTimeframeUnservedPayload> {
  _algovault: { tool: 'scan_trade_calls'; version: string; session_id: string | null };
}

/** REFERRAL-INPRODUCT-NUDGE-W1 trigger (b): min # live (non-HOLD) calls in one scan
 *  to count as a "multi-hit" referral moment (Step-0; scan default limit is 10). */
const SCAN_REFERRAL_MIN_HITS = 3;

// OPS-QUOTA-EXHAUSTION-NOTICE-W1: `UPGRADE_HINT` deleted. It was a hardcoded `suggested_action`
// that promised "or pay per call via x402" on EVERY scan wall — including when no x402 rail was
// live — and duplicated the plan name + signup URL a third time. `buildQuotaSuggestedAction`
// derives the same sentence from the notice context, so the rail is named only when it exists.
const TRACK_RECORD_POINTER =
  'PFE win-rate track record: performance://signal-performance resource (or GET /api/performance-public).';

/**
 * Run a scan with quota gating + envelope. Entry-checks quota (exhausted →
 * structured quota_exhausted response, no scan, no charge), runs the scan, then
 * charges max(1, returned calls) units — HOLD rows included (R-G). `_algovault.quota` reflects the
 * post-charge meter. x402/internal tiers short-circuit to Infinity (no charge).
 */
export async function runScanTradeCall(
  params: ScanTradeCallsParams,
  license: LicenseInfo,
): Promise<ScanTradeCallsResponse | ScanQuotaExhaustedResponse | ScanInvalidRankResponse | ScanTimeframeUnservedResponse> {
  // SCAN-RANKBY-W1: reject an unrecognized lens BEFORE quota/scan/charge. Only a
  // NON-EMPTY unknown token is invalid — omitted/empty (direct + x402 callers that
  // don't apply the Zod default) means the default 'oi', NOT an error.
  const rawRank = params.rankBy;
  if (rawRank != null && String(rawRank).trim() !== '' && resolveRankBy(rawRank) == null) {
    const lenses = rankByTokens();
    return {
      error: 'invalid_rank_by',
      code: 'invalid_parameter',
      message: `Unknown rankBy '${String(params.rankBy)}'. Valid lenses: ${lenses.join(', ')}.`,
      valid_lenses: lenses,
      suggested_action: `Pass one of: ${lenses.join(', ')} (or omit for the default 'oi').`,
      _algovault: withAuthState({ tool: 'scan_trade_calls', version: PKG_VERSION, session_id: getRequestSessionId() ?? null }, license),
    };
  }

  // Retired-venue gate (OPS-BITMART-RETIRE-W1 Q3): a scan naming a wound-down venue is declined by
  // name before quota is charged or the dead adapter is reached. Enum still advertises BITMART, so
  // Zod cannot catch this. Thrown deliberately (named, not an adapter timeout) — same as the other
  // two venue tools.
  await assertVenueNotRetired(params.exchange);

  // OPS-SERVED-CANDLE-TRUTH-W1 CH2: a timeframe the venue does not serve is refused here, before quota, scan or
  // charge, for the same (exchange, timeframe) the scanner would run (the schema's defaults).
  const scanExchange = params.exchange ?? SCAN_EXCHANGE_DEFAULT;
  const scanTimeframe = params.timeframe ?? SCAN_TIMEFRAME_DEFAULT;
  if (!isTimeframeServed(scanExchange, scanTimeframe)) {
    const unserved = new TimeframeUnservedError({ exchange: scanExchange, timeframe: scanTimeframe, servedTimeframes: servedTimeframes(scanExchange) });
    return {
      ...buildTimeframeUnservedPayload(unserved),
      _algovault: withAuthState({ tool: 'scan_trade_calls', version: PKG_VERSION, session_id: getRequestSessionId() ?? null }, license),
    };
  }

  const refCode = referralCodeForKey(license.key);
  const entry = checkQuota(license);
  if (!entry.allowed) {
    // SCAN-MARKET-REGIMES-W1-V2 CH2: the wall body is built by the ONE shared builder
    // (`src/lib/scan-shared.ts` → `buildScanQuotaWall`), moved there verbatim — every defect
    // fixed on this wall (instances 11/13/14, the daily-meter horizon, the x402 branch) now has a
    // single home that `scan_market_regimes` reuses. Byte-identity is pinned by the AC2.2 goldens.
    return {
      ...buildScanQuotaWall('scan_trade_calls', entry, license, refCode),
      _algovault: withAuthState({ tool: 'scan_trade_calls', version: PKG_VERSION, session_id: getRequestSessionId() ?? null }, license),
    };
  }

  const result = await scanTradeCalls(params);
  // R-G: charge per RETURNED VERDICT, HOLD rows included. Charging only the non-HOLD rows made
  // a scan the free-HOLD loophole that re-opens everything R-A closes — a caller could take 50
  // verdicts for the price of one. `Math.max(1, …)` is retained so a scan that returns nothing
  // at all still costs the one call it consumed; clampUnits default-denies anything else.
  const units = Math.max(1, result.calls.length);
  const tracked = trackCall(license, units);

  const sid = getRequestSessionId() ?? null;
  const meta: ScanAlgovaultMeta = {
    tool: 'scan_trade_calls',
    version: PKG_VERSION,
    // The post-charge quota block — monthly pair + `resets_at`, plus the daily pair and `binding`
    // when a daily meter exists (OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH2, instance 10). Built by
    // `buildScanQuotaState` (scan-shared.ts), the ONE copy both screeners project from.
    quota: buildScanQuotaState(tracked, license),
    compatible_with: compatibleWith(),
    signal_performance: TRACK_RECORD_POINTER,
    session_id: sid,
  };
  // Trigger (b): a multi-hit scan (≥ SCAN_REFERRAL_MIN_HITS live calls) → referral
  // hint for a KEYED user. ≤1 aha referral/session, shared with get_trade_call via
  // the single-source aha store (the first aha trigger that session wins).
  // GROWTH-AGENT-SIGNIN-OAUTH-W4-R2 CH1: a commerce-restricted client is never shown the referral offer.
  if (requestClientProfile().commerce === 'open'
    && refCode && sid && result.eligible_non_hold >= SCAN_REFERRAL_MIN_HITS && shouldShowAhaReferral(sid)) {
    meta.upgrade_hint = buildAhaReferral({ from: 'aha_scan', code: refCode, stats: getTrackRecord(), k: result.eligible_non_hold });
    meta.referral_hint = buildReferralHint({ from: 'aha_scan', code: refCode });
  }

  return {
    ...result,
    _algovault: withAuthState(meta, license),
    // Envelope-shared inline proof (live, cached, in-process; fail-open).
    _receipts: formatScanReceipts(getReceiptTrackRecord()),
  };
}

export type { ScanCallItem };
