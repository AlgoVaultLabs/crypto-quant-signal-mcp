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
import { checkQuota, trackCall, getRequestSessionId, monthResetAtMs, periodStartMs, utcDayResetAtMs } from '../lib/license.js';
import { buildQuotaNoticeMessage, buildQuotaSuggestedAction, quotaNoticeFacts } from '../lib/quota-notice.js';
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
// FUNNEL-FIX-AGENT-X402-NUDGE-W1 (Q4): the scanner's own quota wall also offers the x402 branch.
// x402-nudge is a LEAF (no okx-a2mcp/x402-http-routes import) so this tool handler → x402-nudge
// creates no cycle. Dark behind X402_NUDGE_ENABLED.
import { buildSuggestedX402, isX402NudgeEnabled } from '../lib/x402-nudge.js';
import { bindingMeter } from '../lib/binding-meter.js';
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
    .default('15m')
    .describe(PARAM_DESC_SCAN_TIMEFRAME),
  exchange: z.enum(PROMOTED_VENUE_IDS as [PromotedVenueId, ...PromotedVenueId[]]).default('BINANCE').describe(PARAM_DESC_SCAN_EXCHANGE),
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
  oiChangeWindow: z.enum(['1h', '4h', '24h']).default('24h').describe(PARAM_DESC_SCAN_OI_CHANGE_WINDOW),
  // SCAN-RANKBY-REFINEMENTS-W1 CH3: OI-delta basis for the oi_change lens. z.enum rejects an
  // invalid value at the MCP boundary; default 'notional' ⇒ byte-identical. Ignored by other lenses.
  oiBasis: z.enum(['notional', 'contracts']).default('notional').describe(PARAM_DESC_SCAN_OI_BASIS),
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
  recommended_path: 'subscription' | 'x402';
  suggested_action: string;
  /** REFERRAL-INPRODUCT-NUDGE-W1: the limit moment also carries the structured,
   *  allow-listed referral hint (`from: 'limit'`); the `message` leads with it. */
  referral_hint: ReferralHint;
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
 * charges max(1, non-HOLD returned) units. `_algovault.quota` reflects the
 * post-charge meter. x402/internal tiers short-circuit to Infinity (no charge).
 */
export async function runScanTradeCall(
  params: ScanTradeCallsParams,
  license: LicenseInfo,
): Promise<ScanTradeCallsResponse | ScanQuotaExhaustedResponse | ScanInvalidRankResponse> {
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

  const refCode = referralCodeForKey(license.key);
  const entry = checkQuota(license);
  if (!entry.allowed) {
    // Limit moment (the scan wall): referral-prominent message + structured hint.
    // FUNNEL-FIX-AGENT-X402-NUDGE-W1 (Q4): + the additive in-protocol x402 branch, dark behind
    // X402_NUDGE_ENABLED, omitted when no public rail is live (default-deny ⇒ envelope unchanged).
    // OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH2 (instance 11): the wall discriminator is hoisted
    // ABOVE the nudge, because the nudge's noun now projects from it. It was already computed ~20
    // lines below for `noticeCtx`; moving the single `const` up is what lets both read one value
    // rather than two. The predicate itself is unchanged.
    const isDailyWall = entry.limit === 'daily'
      && typeof entry.daily_used === 'number'
      && typeof entry.daily_total === 'number';
    const suggestedX402 = isX402NudgeEnabled()
      ? buildSuggestedX402('scan_trade_calls', isDailyWall ? 'daily' : 'monthly')
      : undefined;
    // OPS-QUOTA-EXHAUSTION-NOTICE-W1: the scanner wall now renders the SAME notice contract as
    // every other surface. Three things changed and each was a real defect:
    //   • `code` was lowercase `tier_limit_reached` while every other surface emitted
    //     `TIER_LIMIT_REACHED` — an agent branching on the code needed two branches for one
    //     event. `error` KEEPS the old lowercase value so existing consumers do not break.
    //   • `suggested_action` was a hardcoded literal promising "or pay per call via x402"
    //     UNCONDITIONALLY — it advertised the rail even when no rail was live. It is now
    //     derived from the same context that decides whether `suggested_x402` is attached.
    //   • the message stated no usage figure and no reset date.
    // OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1-R2 CH3 (Fix 2): this surface passed NO `wall`, so
    // it rendered the MONTHLY noun, the MONTHLY pair and the MONTHLY horizon to a caller refused by
    // the DAILY meter — the exact three-wrong-facts class the `headline()` docblock in
    // quota-notice.ts records costing a day and a half in production. It was still live here.
    //
    // The discriminator and its pair travel TOGETHER. A `wall` on its own would render the daily
    // noun over the monthly numbers, which is a fourth way to be wrong rather than a fix — the same
    // coupling `errors.ts` already enforces through its `isDaily` triple.
    const noticeCtx = {
      meter: 'calls' as const,
      used: isDailyWall ? (entry.daily_used as number) : entry.used,
      limit: isDailyWall ? (entry.daily_total as number) : entry.total,
      wall: isDailyWall ? ('daily' as const) : ('monthly' as const),
      // The reset instant belongs to the wall that refused. `utcDayResetAtMs()` is the same
      // derivation the daily meter enforces against, so `resets_at` cannot disagree with the
      // `retry_after_hours` rendered beside it.
      resetAtMs: isDailyWall ? utcDayResetAtMs() : monthResetAtMs(license),
      periodStartMs: periodStartMs(license),
      referralCode: refCode,
      x402: suggestedX402,
    };
    const facts = quotaNoticeFacts(noticeCtx);
    return {
      error: 'quota_exhausted',
      code: 'TIER_LIMIT_REACHED',
      message: buildQuotaNoticeMessage(noticeCtx),
      // OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH2 (instance 13, Q6). This block used to be
      // `{ used, total, remaining: 0, resets_at }` — ONE FLAT object holding two meters' facts plus
      // a false one. `used`/`total` are the MONTHLY pair, `resets_at` is the wall-derived instant
      // (DAILY when the daily meter refused), and `remaining: 0` was false of the pair beside it:
      // a daily-walled caller still has monthly headroom. Nothing named which meter governed.
      //
      // It now matches `_algovault.quota` exactly — a COMPOSITE, one meter per sub-object, with
      // `binding` naming the governing wall. That is the difference the conformance criterion
      // turns on: `remaining` means "remaining on THIS pair" everywhere else in the family, and
      // one name with two meanings is the single-derivation violation this arc exists to retire.
      quota: {
        used: entry.used,
        total: entry.total,
        remaining: Math.max(0, entry.total - entry.used),
        resets_at: new Date(monthResetAtMs(license)).toISOString(),
        ...(isDailyWall
          ? {
              daily: {
                used: entry.daily_used as number,
                total: entry.daily_total as number,
                remaining: Math.max(0, (entry.daily_total as number) - (entry.daily_used as number)),
                resets_at: new Date(utcDayResetAtMs()).toISOString(),
              },
            }
          : {}),
        binding: isDailyWall ? ('daily' as const) : ('monthly' as const),
      },
      usage_display: facts.usage_display,
      resets_at: facts.resets_at,
      retry_after_days: facts.retry_after_days,
      recommended_path: facts.recommended_path,
      suggested_action: buildQuotaSuggestedAction(noticeCtx),
      referral_hint: buildReferralHint({ from: 'limit', code: refCode }),
      ...(suggestedX402 ? { suggested_x402: suggestedX402 } : {}),
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
  // The ONE derivation of "which meter binds" — never a hand-rolled ratio comparison here. Writing
  // `daily_used / daily_total > used / total` inline would be a SECOND meter test, which is the
  // precise thing this wave exists to make unwritable; `bindingMeter()` also returns `null` for an
  // unmetered tier rather than a misleading 0, which an inline ratio would get wrong.
  const trackedBinding = bindingMeter(
    { used: tracked.used, limit: tracked.total, resetAtMs: monthResetAtMs(license) },
    typeof tracked.daily_used === 'number' && typeof tracked.daily_total === 'number'
      ? { used: tracked.daily_used, limit: tracked.daily_total, resetAtMs: utcDayResetAtMs() }
      : null,
  );
  const meta: ScanAlgovaultMeta = {
    tool: 'scan_trade_calls',
    version: PKG_VERSION,
    // OPS-QUOTA-EXHAUSTION-NOTICE-W1 (R3): `resets_at` joins the long-shipped used/total/remaining
    // so the scanner envelope carries the same quota state as every other tool's `_algovault`.
    //
    // OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH2 (instance 10): ...and now the DAILY pair with it.
    // This was the last success envelope emitting a 4-key block, so a scanner caller pacing at the
    // daily cap read `remaining: <monthly headroom>` on the very response before the wall — the
    // same defect `withQuotaState` fixed for the other three tools in the parent wave's CH2, left
    // behind here because this tool builds its `_algovault` by hand rather than through that helper.
    // Spread-on-presence keeps the no-daily-meter shape byte-identical.
    quota: {
      used: tracked.used,
      total: tracked.total,
      remaining: tracked.remaining,
      resets_at: new Date(monthResetAtMs(license)).toISOString(),
      ...(trackedBinding?.daily && Number.isFinite(trackedBinding.daily.resetAtMs)
        ? {
            daily: {
              used: trackedBinding.daily.used,
              total: trackedBinding.daily.limit,
              remaining: Math.max(0, trackedBinding.daily.limit - trackedBinding.daily.used),
              resets_at: new Date(trackedBinding.daily.resetAtMs).toISOString(),
            },
            binding: trackedBinding.binding,
          }
        : {}),
    },
    compatible_with: ['crypto-quant-risk-mcp', 'crypto-quant-execution-mcp'],
    signal_performance: TRACK_RECORD_POINTER,
    session_id: sid,
  };
  // Trigger (b): a multi-hit scan (≥ SCAN_REFERRAL_MIN_HITS live calls) → referral
  // hint for a KEYED user. ≤1 aha referral/session, shared with get_trade_call via
  // the single-source aha store (the first aha trigger that session wins).
  if (refCode && sid && result.eligible_non_hold >= SCAN_REFERRAL_MIN_HITS && shouldShowAhaReferral(sid)) {
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
