/**
 * EQUITIES-ENGINE-W1 — MCP tool surface for the equity verdict engine.
 *
 * EXPORTED allow-list formatters: they construct ONLY the permitted public keys
 * — outcome_return_pct / outcome_price can never appear because they are never
 * read or written here (and getLatestVerdict doesn't even SELECT them). Quota
 * wiring mirrors the free crypto tools: get_equity_call is HOLD-free (charges
 * only a non-HOLD verdict, like get_trade_call); get_equity_regime charges per
 * call (like get_market_regime — regime has no HOLD). QUOTA-CONSISTENCY-COUNT-
 * ALL-W1 (2026-06-08, Q2=B).
 */
import { trackCall, checkQuota, daysUntilMonthReset } from '../license.js';
import { TierLimitReachedError } from '../errors.js';
import { PKG_VERSION } from '../pkg-version.js';
import type { LicenseInfo } from '../../types.js';
import { normalizeSymbol } from './equity-symbols.js';
import {
  getEquityPool, getUniverseEntry, getAllUniverseSymbols, getLatestVerdict,
  type PublicVerdictRow,
} from './equity-store.js';
import { recordSymbolMiss } from './equity-misses.js';

export interface AlgovaultMeta { tool: string; version: string; source: string; ts: string; }

export interface EquityCallOutput {
  symbol: string;
  call: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  regime: string;
  factors: string[];
  as_of_session: string;
  universe_rank: number | null;
  _algovault: AlgovaultMeta;
}

export interface EquityRegimeOutput {
  symbol: string;
  regime: string;
  confidence: number;
  as_of_session: string;
  _algovault: AlgovaultMeta;
}

export interface EquityErrorOutput {
  error: true;
  code: 'SYMBOL_NOT_IN_UNIVERSE' | 'NO_VERDICT_FOR_SESSION';
  message: string;
  suggested_symbols?: string[];
  universe_size?: number;
  suggested_action?: string;
  _algovault: AlgovaultMeta;
}

function meta(tool: string): AlgovaultMeta {
  return { tool, version: PKG_VERSION, source: 'equity_verdicts', ts: new Date().toISOString() };
}

/** Nearest universe symbols to a query by shared-prefix length (pure). */
export function nearestByPrefix(query: string, symbols: string[], n = 5): string[] {
  const q = (query || '').toUpperCase();
  const sharedLen = (s: string) => {
    let i = 0;
    while (i < q.length && i < s.length && q[i] === s[i]) i++;
    return i;
  };
  return [...symbols].sort((a, b) => sharedLen(b) - sharedLen(a) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, n);
}

/** PURE allow-list formatter for get_equity_call. */
export function formatEquityCall(v: PublicVerdictRow, universe_rank: number | null): EquityCallOutput {
  return {
    symbol: v.symbol,
    call: v.call,
    confidence: v.confidence ?? 0,
    regime: v.regime ?? 'unknown',
    factors: v.factors,
    as_of_session: v.session_date,
    universe_rank,
    _algovault: meta('get_equity_call'),
  };
}

/** PURE allow-list formatter for get_equity_regime. */
export function formatEquityRegime(v: PublicVerdictRow): EquityRegimeOutput {
  return {
    symbol: v.symbol,
    regime: v.regime ?? 'unknown',
    confidence: v.confidence ?? 0,
    as_of_session: v.session_date,
    _algovault: meta('get_equity_regime'),
  };
}

function tierLimitError(license: LicenseInfo, q: { used: number; total: number }): TierLimitReachedError {
  return new TierLimitReachedError({
    currentUsage: q.used,
    monthlyLimit: q.total,
    tier: license.tier,
    suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter&utm_source=mcp_tool&utm_campaign=tier_limit_reached',
    retryAfterDays: daysUntilMonthReset(license),
  });
}

/**
 * Charge one unit, then throw if that pushed over quota — mirrors get_market_regime
 * (regime has no HOLD, so every call is billable). Used by get_equity_regime.
 */
function quotaGate(license: LicenseInfo): void {
  const q = trackCall(license);
  if (!q.allowed) throw tierLimitError(license, q);
}

/**
 * Read-only exhaustion gate — throws if quota is ALREADY exhausted, WITHOUT charging.
 * Mirrors get_trade_call (checkQuota at entry; the charge happens after the verdict,
 * so HOLD verdicts and error paths stay free). Used by get_equity_call.
 */
function assertQuotaAvailable(license: LicenseInfo): void {
  const q = checkQuota(license);
  if (!q.allowed) throw tierLimitError(license, q);
}

/** get_equity_call orchestrator: quota → normalize → universe → latest verdict → format. */
export async function getEquityCall(input: { symbol: string; license?: LicenseInfo }): Promise<EquityCallOutput | EquityErrorOutput> {
  const license = input.license || { tier: 'free' as const, key: null };
  // QUOTA-CONSISTENCY-COUNT-ALL-W1 (Q2=B): read-only gate here; the charge happens
  // AFTER the verdict and only for non-HOLD — HOLD equity calls are free, mirroring
  // get_trade_call. (get_equity_regime still charges per call via quotaGate.)
  assertQuotaAvailable(license);
  const pool = getEquityPool();
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) {
    const all = await getAllUniverseSymbols(pool);
    void recordSymbolMiss(pool, symbol, input.symbol);
    return { error: true, code: 'SYMBOL_NOT_IN_UNIVERSE', message: 'Empty or invalid symbol.', suggested_symbols: [], universe_size: all.length, _algovault: meta('get_equity_call') };
  }
  const entry = await getUniverseEntry(pool, symbol);
  if (!entry) {
    const all = await getAllUniverseSymbols(pool);
    void recordSymbolMiss(pool, symbol, input.symbol);
    return {
      error: true, code: 'SYMBOL_NOT_IN_UNIVERSE',
      message: `${symbol} is not in the AlgoVault equities universe (top US equities by dollar-volume + index/crypto-proxy ETFs).`,
      suggested_symbols: nearestByPrefix(symbol, all),
      universe_size: all.length,
      _algovault: meta('get_equity_call'),
    };
  }
  const v = await getLatestVerdict(pool, symbol);
  if (!v) {
    return {
      error: true, code: 'NO_VERDICT_FOR_SESSION',
      message: `No verdict computed yet for ${symbol}.`,
      suggested_action: 'Verdicts are computed once per session (T+1, after the US close). Check back after the next nightly run.',
      _algovault: meta('get_equity_call'),
    };
  }
  // Charge only for an actionable (non-HOLD) verdict — HOLDs are free (parity with
  // get_trade_call). Error paths above return before this, so they never charge.
  if (v.call !== 'HOLD') trackCall(license);
  return formatEquityCall(v, entry.rank_adv);
}

/** get_equity_regime orchestrator (default symbol SPY). */
export async function getEquityRegime(input: { symbol?: string; license?: LicenseInfo }): Promise<EquityRegimeOutput | EquityErrorOutput> {
  const license = input.license || { tier: 'free' as const, key: null };
  quotaGate(license);
  const pool = getEquityPool();
  const symbol = normalizeSymbol(input.symbol || 'SPY') || 'SPY';
  const entry = await getUniverseEntry(pool, symbol);
  if (!entry) {
    const all = await getAllUniverseSymbols(pool);
    void recordSymbolMiss(pool, symbol, input.symbol);
    return {
      error: true, code: 'SYMBOL_NOT_IN_UNIVERSE',
      message: `${symbol} is not in the AlgoVault equities universe.`,
      suggested_symbols: nearestByPrefix(symbol, all),
      universe_size: all.length,
      _algovault: meta('get_equity_regime'),
    };
  }
  const v = await getLatestVerdict(pool, symbol);
  if (!v) {
    return {
      error: true, code: 'NO_VERDICT_FOR_SESSION',
      message: `No regime computed yet for ${symbol}.`,
      suggested_action: 'Regimes are computed once per session (T+1). Check back after the next nightly run.',
      _algovault: meta('get_equity_regime'),
    };
  }
  return formatEquityRegime(v);
}
