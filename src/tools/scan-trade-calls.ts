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
//     where units = max(1, non-HOLD calls returned) — HOLDs are free (extends
//     the shipped get_trade_call HOLDs-are-free law to batch shape)
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
import { checkQuota, trackCall, getQuotaExhaustedMessage, getRequestSessionId } from '../lib/license.js';
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
import {
  SCAN_TRADE_CALLS_DESCRIPTION,
  PARAM_DESC_SCAN_TOP_N,
  PARAM_DESC_SCAN_TIMEFRAME,
  PARAM_DESC_SCAN_EXCHANGE,
  PARAM_DESC_SCAN_MIN_CONFIDENCE,
  PARAM_DESC_SCAN_INCLUDE_HOLDS,
  PARAM_DESC_SCAN_LIMIT,
  PARAM_DESC_SCAN_RANK_BY,
} from '../tool-descriptions.js';
import type { LicenseInfo } from '../types.js';

export { SCAN_TRADE_CALLS_DESCRIPTION };

/**
 * Zod raw shape for `server.tool`. Exported so the C3 canary can validate
 * bounds without importing index.ts. Promoted-5 venue enum (NOT the 17-value
 * get_trade_call enum — getExchangeTopAssetsWithVolume throws on shadow venues).
 */
export const SCAN_TRADE_CALLS_SCHEMA = {
  topN: z.number().int().min(1).max(100).default(20).describe(PARAM_DESC_SCAN_TOP_N),
  timeframe: z
    .enum(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'])
    .default('15m')
    .describe(PARAM_DESC_SCAN_TIMEFRAME),
  exchange: z.enum(['BINANCE', 'HL', 'BYBIT', 'OKX', 'BITGET']).default('BINANCE').describe(PARAM_DESC_SCAN_EXCHANGE),
  minConfidence: z.number().min(0).max(100).optional().describe(PARAM_DESC_SCAN_MIN_CONFIDENCE),
  includeHolds: z.boolean().default(false).describe(PARAM_DESC_SCAN_INCLUDE_HOLDS),
  limit: z.number().int().min(1).max(100).default(10).describe(PARAM_DESC_SCAN_LIMIT),
  // SCAN-RANKBY-W1: universe-selection lens (param, not a tool — tools/list stays 9).
  // Raw string so the bot can forward an alias (nfr/pfr/…) verbatim; the MCP resolves
  // it via resolveRankBy (the single alias map). Default 'oi' ⇒ byte-identical output.
  rankBy: z.string().optional().default('oi').describe(PARAM_DESC_SCAN_RANK_BY),
};

export interface ScanAlgovaultMeta {
  tool: 'scan_trade_calls';
  version: string;
  quota: { used: number; total: number; remaining: number };
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
  code: 'tier_limit_reached';
  message: string;
  quota: { used: number; total: number; remaining: number };
  suggested_action: string;
  /** REFERRAL-INPRODUCT-NUDGE-W1: the limit moment also carries the structured,
   *  allow-listed referral hint (`from: 'limit'`); the `message` leads with it. */
  referral_hint: ReferralHint;
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

const UPGRADE_HINT = 'Upgrade to Starter at https://api.algovault.com/signup?plan=starter or pay per call via x402.';
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
      _algovault: { tool: 'scan_trade_calls', version: PKG_VERSION, session_id: getRequestSessionId() ?? null },
    };
  }

  const refCode = referralCodeForKey(license.key);
  const entry = checkQuota(license);
  if (!entry.allowed) {
    // Limit moment (the scan wall): referral-prominent message + structured hint.
    return {
      error: 'quota_exhausted',
      code: 'tier_limit_reached',
      message: getQuotaExhaustedMessage(entry.used, entry.total, refCode),
      quota: { used: entry.used, total: entry.total, remaining: 0 },
      suggested_action: UPGRADE_HINT,
      referral_hint: buildReferralHint({ from: 'limit', code: refCode }),
      _algovault: { tool: 'scan_trade_calls', version: PKG_VERSION, session_id: getRequestSessionId() ?? null },
    };
  }

  const result = await scanTradeCalls(params);
  // HOLDs are free — charge only the non-HOLD calls actually returned (>=1).
  const units = Math.max(1, result.eligible_non_hold);
  const tracked = trackCall(license, units);

  const sid = getRequestSessionId() ?? null;
  const meta: ScanAlgovaultMeta = {
    tool: 'scan_trade_calls',
    version: PKG_VERSION,
    quota: { used: tracked.used, total: tracked.total, remaining: tracked.remaining },
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
    _algovault: meta,
    // Envelope-shared inline proof (live, cached, in-process; fail-open).
    _receipts: formatScanReceipts(getReceiptTrackRecord()),
  };
}

export type { ScanCallItem };
