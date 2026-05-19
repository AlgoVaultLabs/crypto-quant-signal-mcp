/**
 * Static per-venue coverage matrix for TIER_3 (TradFi) AlgoVault-canonical symbols.
 *
 * Derived from the TRADFI-SYMBOL-ALIAS-W1 Plan-Mode probe (2026-05-15):
 *   - Probed all 4 CEX instrument-list endpoints (Binance fapi exchangeInfo, Bybit v5
 *     instruments-info, Bitget v2 contracts, OKX v5 public/instruments).
 *   - For each TIER_3 symbol, checked direct match `<COIN>USDT` AND TradFi alias
 *     candidates (`XAU`/`XAG`/`XPT`/`XPD`/`XCU`/`NG` for metals/oil/gas; etc.).
 *   - Live trade-call probe verified the alias-resolved CEX-native symbol returns
 *     plausible spot price (gold ≈ $4555, silver ≈ $77, platinum ≈ $1986, etc.).
 *
 * IMPORTANT — namespace collision: `SPX` on every CEX (and on HL standard perps) is
 * the SPX6900 memecoin (price ≈ $0.40), NOT the S&P 500 index (price ≈ $7400 on HL).
 * `SP500` is the S&P 500 index, HL-only. The `SP500 → SPX` alias was DROPPED in
 * Plan Mode after the spot-price sanity check caught this. See
 * `audits/TRADFI-SYMBOL-ALIAS-W1-endpoint-truth.md` §3.b.
 *
 * Audit:
 *   - Refresh by re-running `audits/TRADFI-SYMBOL-ALIAS-W1-symbol-coverage.csv`'s
 *     generation procedure (documented in the audit file).
 *   - When the CEX side adds/removes a TIER_3 listing, update both this file AND
 *     the adapter's `TRADFI_ALIASES` map in lockstep.
 */

import type { ExchangeId } from '../types.js';
import { isKnownTradFi } from './asset-tiers.js';

const ALL_5: ExchangeId[] = ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET'];

// HL-only TIER_3 symbols — symbols whose CEX listings are absent on all 4
// non-HL promoted CEXes as of 2026-05-15. SP500 included because the CEX `SPX`
// ticker is the SPX6900 memecoin, not the S&P 500 index.
//
// PILOT-ADAPTERS-W2 / C1 (2026-05-19) refinement: VIX moved OUT of HL_ONLY
// into PARTIAL_COVERAGE — Plan-Mode probe rev 2 surfaced VIX_USDT on Gate.io.
// EUR/JPY/JP225/BRENTOIL stay HL_ONLY here; C2 (MEXC) moves them out + adds
// PARTIAL rows for MEXC shadow-venue listings (EUR_USDT, JPY_USDT, JP225_USDT,
// UKOIL_USDT). Per-chapter additive widening pattern matches the
// EXCHANGE-SHADOW-PROMOTE-W1 / per-chapter system-map.md touch lesson.
const HL_ONLY: Set<string> = new Set([
  'ALUMINIUM', 'BRENTOIL', 'BX', 'CORN', 'DKNG', 'DXY', 'EUR', 'HYUNDAI',
  'JP225', 'JPY', 'KIOXIA', 'KR200', 'PURRDAT', 'RIVN', 'SKHX', 'SMSN',
  'SOFTBANK', 'SP500', 'TTF', 'URANIUM', 'URNM', 'WHEAT', 'XYZ100',
]);

// Partial-coverage TIER_3 symbols — supported on a subset of venues. HL is
// implicit (always present for TIER_3). Order within array is presentational
// only.
//
// PILOT-ADAPTERS-W2 / C1 (2026-05-19): Gate.io shadow-venue listings added to
// existing rows + new rows per Plan-Mode probe rev 2 (Gate has 26 TradFi
// symbols). C2 (MEXC) + C3 (KuCoin) extend this same map.
const PARTIAL_COVERAGE: Record<string, ExchangeId[]> = {
  // Existing promoted-CEX rows extended with GATE where Plan-Mode probe found a listing
  AMD:       ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE'],
  BABA:      ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE'],
  COPPER:    ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE'],   // Gate has XCU_USDT (alias)
  COST:      ['HL', 'BINANCE', 'BITGET', 'GATE'],
  CRWV:      ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE'],
  GME:       ['HL', 'BINANCE', 'BITGET'],                  // not on Gate
  HIMS:      ['HL', 'BITGET', 'GATE'],
  LLY:       ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE'],
  NATGAS:    ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE'],   // Gate has NG_USDT (alias)
  NFLX:      ['HL', 'BINANCE', 'BITGET', 'GATE'],
  PALLADIUM: ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE'],   // Gate has XPD_USDT (alias)
  PLATINUM:  ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE'],   // Gate has XPT_USDT (alias)
  USAR:      ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE'],
  XLE:       ['HL', 'BITGET'],                              // not on Gate (Plan-Mode probe)

  // NEW rows: HL_ONLY → shadow-venue-extended (W2 moves these out of HL_ONLY)
  VIX:       ['HL', 'GATE'],                                // Gate has VIX_USDT
  // BRENTOIL: moved to a C2 row (MEXC has UKOIL_USDT). Stays HL-only until C2.
  // EUR/JPY/JP225: moved to a C2 row (MEXC has EUR_USDT, JPY_USDT, JP225_USDT). Stays HL-only until C2.

  // NEW rows: TradFi symbols that previously defaulted to ALL_5 but Gate.io adds shadow-venue coverage
  GOLD:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'],     // Gate has XAU_USDT (alias)
  SILVER:    ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'],     // Gate has XAG_USDT (alias)
  CL:        ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'],     // Gate has CL_USDT
  EWJ:       ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'],     // Gate has EWJ_USDT
  EWY:       ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'],     // Gate has EWY_USDT
  INTC:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'],
  LITE:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'],
  MSFT:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'],
  MU:        ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'],
  SNDK:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'],
  TSM:       ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'],
};

/**
 * Return the list of venues that support the given AlgoVault-canonical coin.
 *
 * Resolution order:
 *   1. Non-TradFi (crypto majors, alts, memes) → all 5 venues are presumed to
 *      support it. CEX-specific listing gaps for crypto are handled by the
 *      adapter (return 400 from upstream → tool surfaces a generic
 *      `UPSTREAM_400`). This function only carries TradFi-specific knowledge.
 *   2. TIER_3 + HL_ONLY → `['HL']`.
 *   3. TIER_3 + PARTIAL_COVERAGE → explicit per-coin list.
 *   4. TIER_3 + (everything else) → all 5 venues (default).
 *
 * Note: this function is intentionally permissive on the upper bound (returns
 * `ALL_5` for unknown coins) so it doesn't accidentally narrow the supported
 * venue list for fresh listings before this static matrix is re-probed. The
 * tightening happens via the `TRADFI_SYMBOL_UNSUPPORTED_ON_VENUE` error path
 * which only fires for KNOWN TradFi symbols on unsupported venues.
 */
export function getVenuesSupporting(coin: string): ExchangeId[] {
  const symbol = coin.toUpperCase();
  if (!isKnownTradFi(symbol)) return ALL_5;
  if (HL_ONLY.has(symbol)) return ['HL'];
  if (PARTIAL_COVERAGE[symbol]) return PARTIAL_COVERAGE[symbol];
  return ALL_5;
}

/**
 * Is the AlgoVault-canonical coin supported on the requested venue?
 * Convenience wrapper around `getVenuesSupporting`.
 */
export function isVenueSupportedFor(coin: string, exchange: ExchangeId): boolean {
  return getVenuesSupporting(coin).includes(exchange);
}

/**
 * Probe-date marker — useful for future "is this matrix stale?" audits.
 * Update in lockstep with re-running the alias coverage CSV.
 */
export const COVERAGE_PROBED_AT = '2026-05-19';   // PILOT-ADAPTERS-W2 / C1 — Gate.io shadow-venue TradFi coverage added; C2 (MEXC) + C3 (KuCoin) follow
