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
import { PKG_VERSION } from '../lib/pkg-version.js';
import {
  SCAN_TRADE_CALLS_DESCRIPTION,
  PARAM_DESC_SCAN_TOP_N,
  PARAM_DESC_SCAN_TIMEFRAME,
  PARAM_DESC_SCAN_EXCHANGE,
  PARAM_DESC_SCAN_MIN_CONFIDENCE,
  PARAM_DESC_SCAN_INCLUDE_HOLDS,
  PARAM_DESC_SCAN_LIMIT,
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
};

export interface ScanAlgovaultMeta {
  tool: 'scan_trade_calls';
  version: string;
  quota: { used: number; total: number; remaining: number };
  compatible_with: string[];
  signal_performance: string;
  session_id: string | null;
}

export interface ScanTradeCallsResponse extends ScanTradeCallsResult {
  _algovault: ScanAlgovaultMeta;
}

export interface ScanQuotaExhaustedResponse {
  error: 'quota_exhausted';
  code: 'tier_limit_reached';
  message: string;
  quota: { used: number; total: number; remaining: number };
  suggested_action: string;
  _algovault: { tool: 'scan_trade_calls'; version: string; session_id: string | null };
}

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
): Promise<ScanTradeCallsResponse | ScanQuotaExhaustedResponse> {
  const entry = checkQuota(license);
  if (!entry.allowed) {
    return {
      error: 'quota_exhausted',
      code: 'tier_limit_reached',
      message: getQuotaExhaustedMessage(entry.used, entry.total),
      quota: { used: entry.used, total: entry.total, remaining: 0 },
      suggested_action: UPGRADE_HINT,
      _algovault: { tool: 'scan_trade_calls', version: PKG_VERSION, session_id: getRequestSessionId() ?? null },
    };
  }

  const result = await scanTradeCalls(params);
  // HOLDs are free — charge only the non-HOLD calls actually returned (>=1).
  const units = Math.max(1, result.eligible_non_hold);
  const tracked = trackCall(license, units);

  return {
    ...result,
    _algovault: {
      tool: 'scan_trade_calls',
      version: PKG_VERSION,
      quota: { used: tracked.used, total: tracked.total, remaining: tracked.remaining },
      compatible_with: ['crypto-quant-risk-mcp', 'crypto-quant-execution-mcp'],
      signal_performance: TRACK_RECORD_POINTER,
      session_id: getRequestSessionId() ?? null,
    },
  };
}

export type { ScanCallItem };
