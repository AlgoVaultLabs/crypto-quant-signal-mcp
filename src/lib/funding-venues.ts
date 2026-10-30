import type { ExchangeId } from '../types.js';

/**
 * OPS-FUNDING-ARB-EXPAND-W1 — the funding-arb venue SoT. Maps each adapter funding-feed venue-string
 * (as emitted by `getPredictedFundings()`) → its canonical `ExchangeId` + funding INTERVAL (hours),
 * for interval-correct annualization (`annualizeFunding`) + the per-leg liquidity gate (via the scan
 * SoT `getVenueUniverse`).
 *
 * QUALIFYING SET (architect-ratified Q-A): the promoted venues with a reliable `getPredictedFundings`
 * feed (funding rate + `nextFundingTime`), live-probed 2026-07-01. BITGET joined in DECISION-CALL-V1-W1
 * R3, when its `current-fund-rate` feed (with `nextUpdate`) replaced the `tickers` source that had no
 * next funding time. EXCLUDED — MEXC/HTX/BINGX/PHEMEX (empty feed). Declared intervals (HL hourly, the
 * rest 8h) are the FALLBACK; per-contract intervals come from the feeds themselves. A venue-string NOT
 * in this map is skipped by the engine (never guess its interval → no false spread).
 * `fetchedVia` (DECISION-CALL-V1-W1 R2) = the adapter whose predicted-funding feed carries the row. R3
 * points every venue at its OWN feed: HL's aggregate copy of Binance/Bybit covered 41% / 68% of their
 * top 100 by liquidity, their own bulk feeds 96% / 98% (measured 2026-10-24).
 */
export const FUNDING_VENUE_META: Record<string, { exchangeId: ExchangeId; intervalHours: number; fetchedVia: ExchangeId }> = {
  HlPerp:     { exchangeId: 'HL',      intervalHours: 1, fetchedVia: 'HL' },
  BinPerp:    { exchangeId: 'BINANCE', intervalHours: 8, fetchedVia: 'BINANCE' },
  BybitPerp:  { exchangeId: 'BYBIT',   intervalHours: 8, fetchedVia: 'BYBIT' },
  GatePerp:   { exchangeId: 'GATE',    intervalHours: 8, fetchedVia: 'GATE' },
  KuCoinPerp: { exchangeId: 'KUCOIN',  intervalHours: 8, fetchedVia: 'KUCOIN' },
  AsterPerp:  { exchangeId: 'ASTER',   intervalHours: 8, fetchedVia: 'ASTER' },
  OKXPerp:    { exchangeId: 'OKX',     intervalHours: 8, fetchedVia: 'OKX' },
  BitgetPerp: { exchangeId: 'BITGET',  intervalHours: 8, fetchedVia: 'BITGET' },
};

/**
 * The adapters whose `getPredictedFundings()` the arb FETCHES + merges — DERIVED: the unique
 * `fetchedVia` values in META declaration order (DECISION-CALL-V1-W1 R2), so a venue row and the
 * adapter that supplies it can never be declared in two places. `fetchedVia` names the adapter
 * whose feed carries that venue-string; since R3 every venue is fetched from its OWN feed. HL's feed
 * still also carries BinPerp/BybitPerp rows (a cross-venue aggregate) — the merge takes a
 * venue-string ONLY from its `fetchedVia` adapter, so those copies are dropped, never double-counted.
 */
export const FUNDING_ARB_FETCH_ADAPTERS: readonly ExchangeId[] = [
  ...new Set(Object.values(FUNDING_VENUE_META).map((m) => m.fetchedVia)),
];

/**
 * The PUBLIC funding-arb venue count — the number of venues `scan_funding_arb` evaluates. SINGLE SoT
 * for every count surface (landing copy `data-tr-field="funding_venue_count"`, JSON-LD, and
 * `/api/performance-public.funding_venue_count`). Derived from `FUNDING_VENUE_META` (the QUALIFYING
 * set the engine actually iterates), NOT `FUNDING_ARB_FETCH_ADAPTERS.length` — the two are equal
 * only because every venue is fetched from its own feed since DECISION-CALL-V1-W1 R3; a future
 * aggregate feed would fan one adapter out to several venue-strings again. A venue enters this count
 * ONLY when promoted into `FUNDING_VENUE_META` (reliable `getPredictedFundings` incl. `nextFundingTime`),
 * so the public claim never inflates ahead of the engine. 7 → 8 with Bitget (DECISION-CALL-V1-W1 R3).
 * OPS-LANDING-FUNDING-VENUE-RECONCILE-W1.
 */
export const FUNDING_VENUE_COUNT: number = Object.keys(FUNDING_VENUE_META).length;

/**
 * Funding-copy short label per `ExchangeId` (e.g. "Gate", not the EXCHANGES "Gate.io" label) — the
 * form used in the docs.html-canonical "N venues: Hyperliquid, Binance, Bybit, Gate, KuCoin, Aster,
 * OKX, and Bitget" line. Keyed by the qualifying exchangeIds only.
 */
const FUNDING_VENUE_SHORT_LABEL: Partial<Record<ExchangeId, string>> = {
  HL: 'Hyperliquid', BINANCE: 'Binance', BYBIT: 'Bybit', GATE: 'Gate',
  KUCOIN: 'KuCoin', ASTER: 'Aster', OKX: 'OKX', BITGET: 'Bitget',
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

/**
 * The funding-arb venue list rendered as public-copy text ("A, B, …, and Z") — single-derived from
 * FUNDING_VENUE_LABELS. Imported by non-live-bindable surfaces (e.g. `src/scripts/agent-forum-post.ts`)
 * so their venue naming never drifts; the landing pages mirror this exact string as a static list and
 * the CH4 canary asserts the two agree (name-list == FUNDING_VENUE_COUNT).
 */
export const FUNDING_VENUE_LIST_TEXT: string =
  FUNDING_VENUE_LABELS.length > 1
    ? `${FUNDING_VENUE_LABELS.slice(0, -1).join(', ')}, and ${FUNDING_VENUE_LABELS[FUNDING_VENUE_LABELS.length - 1]}`
    : FUNDING_VENUE_LABELS[0];
