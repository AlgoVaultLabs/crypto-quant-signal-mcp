import type { ExchangeId } from '../types.js';

/**
 * OPS-FUNDING-ARB-EXPAND-W1 — the funding-arb venue SoT. Maps each adapter funding-feed venue-string
 * (as emitted by `getPredictedFundings()`) → its canonical `ExchangeId` + funding INTERVAL (hours),
 * for interval-correct annualization (`annualizeFunding`) + the per-leg liquidity gate (via the scan
 * SoT `getVenueUniverse`).
 *
 * QUALIFYING SET (architect-ratified Q-A): the 7 promoted venues with a reliable `getPredictedFundings`
 * feed (funding rate + `nextFundingTime`), live-probed 2026-07-01. EXCLUDED — BITGET (feed but NO
 * `nextFundingTime` → a degraded urgency dimension on every opportunity; re-include when it exposes
 * one), MEXC/HTX/BINGX/PHEMEX (empty feed). Intervals: HL hourly; the rest 8h (live-probed cadence).
 * A venue-string NOT in this map is skipped by the engine (never guess its interval → no false spread).
 */
export const FUNDING_VENUE_META: Record<string, { exchangeId: ExchangeId; intervalHours: number }> = {
  HlPerp:     { exchangeId: 'HL',      intervalHours: 1 },
  BinPerp:    { exchangeId: 'BINANCE', intervalHours: 8 },
  BybitPerp:  { exchangeId: 'BYBIT',   intervalHours: 8 },
  GatePerp:   { exchangeId: 'GATE',    intervalHours: 8 },
  KuCoinPerp: { exchangeId: 'KUCOIN',  intervalHours: 8 },
  AsterPerp:  { exchangeId: 'ASTER',   intervalHours: 8 },
  OKXPerp:    { exchangeId: 'OKX',     intervalHours: 8 },
};

/**
 * The adapters whose `getPredictedFundings()` the arb FETCHES + merges (C2). HL's feed is a cross-venue
 * AGGREGATE (returns HlPerp/BinPerp/BybitPerp), so we do NOT separately call the Binance/Bybit adapters
 * — their venue-strings arrive via HL, preserving the EXACT funding source of the pre-expansion 3-venue
 * arb (0-regression). GATE/KUCOIN/ASTER/OKX each contribute their own single venue.
 */
export const FUNDING_ARB_FETCH_ADAPTERS: readonly ExchangeId[] = ['HL', 'GATE', 'KUCOIN', 'ASTER', 'OKX'];

/**
 * The PUBLIC funding-arb venue count — the number of venues `scan_funding_arb` evaluates. SINGLE SoT
 * for every count surface (landing copy `data-tr-field="funding_venue_count"`, JSON-LD, and
 * `/api/performance-public.funding_venue_count`). Derived from `FUNDING_VENUE_META` (the QUALIFYING
 * set the engine actually iterates), NOT `FUNDING_ARB_FETCH_ADAPTERS.length` (=5 fetch adapters — HL's
 * feed aggregates Binance+Bybit, so 5 adapters fan out to 7 venue-strings). A venue enters this count
 * ONLY when promoted into `FUNDING_VENUE_META` (reliable `getPredictedFundings` incl. `nextFundingTime`)
 * — Bitget stays excluded until it exposes one, so the public claim never inflates ahead of the engine.
 * Live `scan_funding_arb` handshake 2026-07-15 confirmed exactly these 7 (Bitget absent).
 * OPS-LANDING-FUNDING-VENUE-RECONCILE-W1.
 */
export const FUNDING_VENUE_COUNT: number = Object.keys(FUNDING_VENUE_META).length;

/**
 * Funding-copy short label per `ExchangeId` (e.g. "Gate", not the EXCHANGES "Gate.io" label) — the
 * form used in the docs.html-canonical "N venues: Hyperliquid, Binance, Bybit, Gate, KuCoin, Aster,
 * and OKX" line. Keyed by the qualifying exchangeIds only.
 */
const FUNDING_VENUE_SHORT_LABEL: Partial<Record<ExchangeId, string>> = {
  HL: 'Hyperliquid', BINANCE: 'Binance', BYBIT: 'Bybit', GATE: 'Gate',
  KUCOIN: 'KuCoin', ASTER: 'Aster', OKX: 'OKX',
};

/**
 * Ordered display labels for the funding-arb venues (in `FUNDING_VENUE_META` declaration order) — the
 * SoT for the public "N venues: <names>" copy line AND the name-list==count canary
 * (OPS-LANDING-FUNDING-VENUE-RECONCILE-W1 CH4). DERIVED from `FUNDING_VENUE_META`, so the name list's
 * length + membership can never drift from `FUNDING_VENUE_COUNT`: a future META add that bumps the
 * count but not the labels FAILS CI instead of shipping "8 venues: <7 names>".
 */
export const FUNDING_VENUE_LABELS: readonly string[] = Object.values(FUNDING_VENUE_META).map(
  (v) => FUNDING_VENUE_SHORT_LABEL[v.exchangeId] ?? v.exchangeId,
);
