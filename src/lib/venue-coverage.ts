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
// PILOT-ADAPTERS-W2 / C1 + C2 + C3 (2026-05-19) refinement: VIX (C1) + EUR
// + JPY + JP225 + BRENTOIL (C2) moved OUT of HL_ONLY into PARTIAL_COVERAGE.
// They remain HL-only AMONG THE 5 PROMOTED venues but are reachable via
// shadow. C3 (KuCoin) extends existing rows + adds 11 NEW PARTIAL rows for
// stocks (AAPL/AMZN/COIN/GOOGL/HOOD/META/MSTR/NVDA/ORCL/PLTR/TSLA) that
// KuCoin lists but the 5 promoted venues + Gate (C1) + MEXC (C2) don't.
const HL_ONLY: Set<string> = new Set([
  'ALUMINIUM', 'BX', 'CORN', 'DKNG', 'DXY', 'HYUNDAI',
  'KIOXIA', 'KR200', 'PURRDAT', 'RIVN', 'SKHX', 'SMSN',
  'SOFTBANK', 'TTF', 'URANIUM', 'URNM', 'WHEAT', 'XYZ100',
  // PILOT-ADAPTERS-W3A / C1 (2026-05-20): SP500 moved OUT of HL_ONLY into
  // PARTIAL_COVERAGE below. Phemex uniquely lists the REAL S&P 500 as
  // `SP500USDT` ($7338 mark, verified via semantic-fingerprint probe). The
  // SPX/SPX6900 memecoin namespace collision is unchanged — `SPX` is NEVER
  // aliased on any venue.
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
  AMD:       ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE', 'KUCOIN'],
  BABA:      ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE', 'KUCOIN'],
  COPPER:    ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE', 'MEXC', 'KUCOIN', 'PHEMEX'],   // W2 C1 Gate XCU + C2 MEXC + C3 KuCoin literal; W3A C1 Phemex COPPER direct
  COST:      ['HL', 'BINANCE', 'BITGET', 'GATE', 'KUCOIN'],
  CRWV:      ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE', 'KUCOIN'],
  GME:       ['HL', 'BINANCE', 'BITGET'],                  // not on Gate/MEXC/KuCoin
  HIMS:      ['HL', 'BITGET', 'GATE', 'KUCOIN'],
  LLY:       ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE', 'KUCOIN'],
  NATGAS:    ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE', 'KUCOIN', 'PHEMEX'],   // Gate NG (alias) + KuCoin direct + W3A C1 Phemex NG (alias)
  NFLX:      ['HL', 'BINANCE', 'BITGET', 'GATE', 'KUCOIN'],
  PALLADIUM: ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE', 'MEXC', 'KUCOIN', 'PHEMEX'],   // W2 Gate/MEXC/KuCoin XPD + W3A C1 Phemex XPD
  PLATINUM:  ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE', 'MEXC', 'KUCOIN', 'PHEMEX'],   // W2 Gate/MEXC/KuCoin XPT + W3A C1 Phemex XPT
  USAR:      ['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE', 'KUCOIN'],
  XLE:       ['HL', 'BITGET', 'MEXC'],                      // C2 MEXC adds (not on Gate per Plan-Mode probe)

  // NEW rows (C1 + C2 — moved OUT of HL_ONLY into PARTIAL_COVERAGE):
  VIX:       ['HL', 'GATE', 'PHEMEX'],                      // W2 C1: Gate VIX_USDT; W3A C1: Phemex VIXUSDT direct
  EUR:       ['HL', 'MEXC'],                                // C2: MEXC has EUR_USDT
  JPY:       ['HL', 'MEXC'],                                // C2: MEXC has JPY_USDT
  JP225:     ['HL', 'MEXC'],                                // C2: MEXC has JP225_USDT
  BRENTOIL:  ['HL', 'MEXC'],                                // C2: MEXC has UKOIL_USDT (alias)

  // NEW rows: TradFi symbols that previously defaulted to ALL_5 but Gate.io adds shadow-venue coverage
  GOLD:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE', 'MEXC', 'KUCOIN', 'PHEMEX'],     // W2 Gate XAU + MEXC XAUT + KuCoin XAUT; W3A C1 Phemex XAU
  SILVER:    ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE', 'MEXC', 'KUCOIN', 'PHEMEX'],     // W2 Gate XAG + MEXC literal + KuCoin XAG; W3A C1 Phemex XAG
  CL:        ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE', 'MEXC', 'KUCOIN'],     // C1 Gate + C2 MEXC USOIL + C3 KuCoin CL direct
  EWJ:       ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE', 'MEXC', 'KUCOIN'],     // C1+C2+C3
  EWY:       ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE', 'MEXC', 'KUCOIN'],     // C1+C2+C3
  INTC:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE', 'KUCOIN'],
  LITE:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE', 'KUCOIN'],
  MSFT:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE', 'KUCOIN', 'PHEMEX'],   // W3A C1 Phemex MSFTUSDT direct
  MU:        ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE', 'KUCOIN'],
  SNDK:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE', 'KUCOIN'],
  TSM:       ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE', 'KUCOIN'],

  // C3-only NEW rows (KuCoin extends stocks beyond Gate's 14 + adds new ones)
  // W3A C1 (2026-05-20): Phemex adds AAPL/AMZN/COIN/GOOGL/META/MSTR/NVDA/TSLA
  // (8 stocks live-probed under perpProductsV2). ORCL/HOOD/PLTR/CRCL NOT on Phemex.
  AAPL:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'KUCOIN', 'PHEMEX'],   // KuCoin AAPLUSDTM + Phemex AAPLUSDT
  AMZN:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'KUCOIN', 'PHEMEX'],   // KuCoin AMZNUSDTM + Phemex AMZNUSDT
  COIN:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'KUCOIN', 'PHEMEX'],
  GOOGL:     ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'KUCOIN', 'PHEMEX'],
  HOOD:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'KUCOIN'],   // not on Phemex per W3A C1 probe
  META:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'KUCOIN', 'PHEMEX'],
  MSTR:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'KUCOIN', 'PHEMEX'],
  NVDA:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'KUCOIN', 'PHEMEX'],
  ORCL:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'KUCOIN'],   // not on Phemex per W3A C1 probe
  PLTR:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'KUCOIN'],   // not on Phemex per W3A C1 probe
  TSLA:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'KUCOIN', 'PHEMEX'],
  CRCL:      ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'KUCOIN'],   // not on Phemex per W3A C1 probe

  // PILOT-ADAPTERS-W3A / C1 (2026-05-20): NEW rows for Phemex-unique TradFi
  // listings (SP500 moved out of HL_ONLY; USOIL was implicit ALL_5 default).
  SP500:     ['HL', 'PHEMEX'],   // moved out of HL_ONLY; Phemex SP500USDT is the REAL S&P 500 ($7338)
  USOIL:     ['HL', 'PHEMEX'],   // Phemex CLOUSDT (alias from USOIL via TRADFI_ALIASES)
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
export const COVERAGE_PROBED_AT = '2026-05-20';   // PILOT-ADAPTERS-W3A / C1 — Phemex shadow-venue TradFi coverage added (16 row extensions + SP500 moved out of HL_ONLY + USOIL new row); semantic-fingerprint probes confirm SP500USDT=$7338 (real S&P 500) vs SPXUSDT=$0.36 (memecoin)
