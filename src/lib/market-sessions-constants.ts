/**
 * Pure data substrate for underlying-market session classification
 * (TRADFI-SIGNAL-HARDENING-W1, 2026-06-04).
 *
 * Separated into its own module (no I/O, no logic) so the holiday table, the
 * static asset-class fallback map, and the funding-note strings are all
 * test-importable per the CLAUDE.md "pure-data module for test-importable
 * constants" rule.
 *
 * WHY a session layer at all: Binance equity perps use an Orderbook-EWMA price
 * index on weekends (±3% mark cap, since 2026-05-16) and Bybit freezes the
 * index ±3%; pre-IPO marks are a pure internal trade-price with no external
 * market. When the underlying cash market is CLOSED, perp candles reflect
 * capped synthetic drift rather than price discovery — a `get_market_regime`
 * RANGING read on a Saturday can mislead an agent into mean-reversion into a
 * Monday gap. This module is the source-of-truth for "is the underlying
 * market open right now?".
 */

/** The five underlying asset classes we session-classify. CRYPTO = 24/7. */
export type AssetClass = 'CRYPTO' | 'EQUITY' | 'KR_EQUITY' | 'COMMODITY' | 'PREMARKET';

export interface MarketHoliday {
  /** ISO calendar date in America/New_York local terms (YYYY-MM-DD). */
  date: string;
  name: string;
  /** Primary source for the entry (auditability). */
  source: string;
}

/**
 * NYSE full-day closures for 2026–2027.
 *
 * SOURCE: NYSE Group "2026, 2027 and 2028 Holiday and Early Closings Calendar"
 * press release (ir.theice.com / nasdaq.com, 2024-11) cross-checked against
 * calendarlabs.com/nyse-market-holidays-2026 and Fidelity/AARP stock-market-
 * holiday guides (all fetched 2026-06-04).
 *
 * v1 MODELS FULL-DAY CLOSURES ONLY. The 1:00pm ET early-close days
 * (2026-11-27 day-after-Thanksgiving, 2026-12-24 Christmas Eve, 2027-11-26,
 * etc.) are intentionally NOT listed: on an early-close day the underlying
 * cash market is still OPEN, so the "capped synthetic index" risk does not
 * apply and no CLOSED caveat is warranted. Note the resolved-observance
 * subtleties already baked in: 2026-07-03 is a FULL closure (July 4 is a
 * Saturday → observed the preceding Friday); 2027-07-05 (July 4 is a Sunday →
 * observed the following Monday); 2027-06-18 / 2027-12-24 are Saturday-holiday
 * observances on the preceding Friday.
 *
 * STALENESS GUARD: `tests/unit/market-sessions.test.ts` fails once we are in
 * the final month of the latest covered year without a following year's table
 * (see `latestHolidayYear`). When that canary trips, append the next year's
 * NYSE calendar here.
 */
export const US_MARKET_HOLIDAYS: MarketHoliday[] = [
  // ── 2026 (10 full closures) ──
  { date: '2026-01-01', name: "New Year's Day",              source: 'NYSE 2026 calendar' },
  { date: '2026-01-19', name: 'Martin Luther King, Jr. Day', source: 'NYSE 2026 calendar' },
  { date: '2026-02-16', name: "Washington's Birthday",       source: 'NYSE 2026 calendar' },
  { date: '2026-04-03', name: 'Good Friday',                 source: 'NYSE 2026 calendar' },
  { date: '2026-05-25', name: 'Memorial Day',                source: 'NYSE 2026 calendar' },
  { date: '2026-06-19', name: 'Juneteenth',                  source: 'NYSE 2026 calendar' },
  { date: '2026-07-03', name: 'Independence Day (observed)', source: 'NYSE 2026 calendar — Jul 4 is Saturday' },
  { date: '2026-09-07', name: 'Labor Day',                   source: 'NYSE 2026 calendar' },
  { date: '2026-11-26', name: 'Thanksgiving Day',            source: 'NYSE 2026 calendar' },
  { date: '2026-12-25', name: 'Christmas Day',               source: 'NYSE 2026 calendar' },
  // ── 2027 (10 full closures) ──
  { date: '2027-01-01', name: "New Year's Day",              source: 'NYSE 2027 calendar' },
  { date: '2027-01-18', name: 'Martin Luther King, Jr. Day', source: 'NYSE 2027 calendar' },
  { date: '2027-02-15', name: "Washington's Birthday",       source: 'NYSE 2027 calendar' },
  { date: '2027-03-26', name: 'Good Friday',                 source: 'NYSE 2027 calendar' },
  { date: '2027-05-31', name: 'Memorial Day',                source: 'NYSE 2027 calendar' },
  { date: '2027-06-18', name: 'Juneteenth (observed)',       source: 'NYSE 2027 calendar — Jun 19 is Saturday' },
  { date: '2027-07-05', name: 'Independence Day (observed)', source: 'NYSE 2027 calendar — Jul 4 is Sunday' },
  { date: '2027-09-06', name: 'Labor Day',                   source: 'NYSE 2027 calendar' },
  { date: '2027-11-25', name: 'Thanksgiving Day',            source: 'NYSE 2027 calendar' },
  { date: '2027-12-24', name: 'Christmas (observed)',        source: 'NYSE 2027 calendar — Dec 25 is Saturday' },
];

const HOLIDAY_DATE_SET: ReadonlySet<string> = new Set(US_MARKET_HOLIDAYS.map(h => h.date));

/** True when `isoDate` (YYYY-MM-DD, America/New_York local) is a full NYSE closure. */
export function isUsMarketHoliday(isoDate: string): boolean {
  return HOLIDAY_DATE_SET.has(isoDate);
}

/** Latest calendar year present in the holiday table — used by the staleness canary. */
export function latestHolidayYear(): number {
  return US_MARKET_HOLIDAYS.reduce((max, h) => Math.max(max, Number(h.date.slice(0, 4))), 0);
}

/**
 * Binance `underlyingType` (live `exchangeInfo` discriminator on
 * `contractType: "TRADIFI_PERPETUAL"`) → our AssetClass. This is the
 * authoritative auto-detection path: a NEW Binance TradFi listing classifies
 * itself the moment it appears in `exchangeInfo`, zero code change.
 */
export const BINANCE_UNDERLYING_TO_ASSET_CLASS: Record<string, AssetClass> = {
  EQUITY: 'EQUITY',
  KR_EQUITY: 'KR_EQUITY',
  COMMODITY: 'COMMODITY',
  PREMARKET: 'PREMARKET',
};

/**
 * Static Tier-3 fallback: canonical AlgoVault coin symbol → AssetClass.
 *
 * Only consulted when the live `exchangeInfo` auto-detection path is
 * unavailable (non-Binance venues, or a Binance fetch failure with no warm
 * cache). A symbol absent here resolves to `UNKNOWN` (renders NO caveat) —
 * fail-safe: we never assert a session state we can't substantiate.
 *
 * MAINTENANCE
 * - Verify quarterly against live `GET fapi.binance.com/fapi/v1/exchangeInfo`
 *   (`underlyingType` per `contractType:"TRADIFI_PERPETUAL"`) and the HL xyz
 *   TradFi universe in `asset-tiers.ts` `TRADFI_FALLBACK`.
 * - Degradation envelope: a symbol that DROPS from the live universe but stays
 *   here keeps its class until the next manual prune (acceptable — only affects
 *   the off-Binance fallback path). A NEW Binance listing is auto-detected live
 *   regardless of this map, so it never needs a manual add for Binance.
 * - SEMANTIC TRAP (CLAUDE.md): `SPX` on CEX/HL is the SPX6900 MEMECOIN (~$0.40),
 *   NOT the S&P 500 (`SP500`, HL-only, ~$7400). SPX is deliberately OMITTED so
 *   it falls through to CRYPTO. Likewise FX (`JPY`/`EUR`/`DXY`) and the HL
 *   `XYZ100` crypto-perp index are omitted (no confident equity/commodity
 *   session) → UNKNOWN/CRYPTO, no caveat.
 */
export const STATIC_ASSET_CLASS_MAP: Record<string, AssetClass> = {
  // ── EQUITY: US single-names + US-listed ETFs/indices (US RTH sessions) ──
  TSLA: 'EQUITY', NVDA: 'EQUITY', AAPL: 'EQUITY', MSFT: 'EQUITY', GOOGL: 'EQUITY',
  META: 'EQUITY', AMZN: 'EQUITY', AMD: 'EQUITY', ORCL: 'EQUITY', NFLX: 'EQUITY',
  PLTR: 'EQUITY', COIN: 'EQUITY', HOOD: 'EQUITY', INTC: 'EQUITY', MU: 'EQUITY',
  MSTR: 'EQUITY', BABA: 'EQUITY', LLY: 'EQUITY', COST: 'EQUITY', RIVN: 'EQUITY',
  TSM: 'EQUITY', CRCL: 'EQUITY', SNDK: 'EQUITY', CRWV: 'EQUITY', HIMS: 'EQUITY',
  DKNG: 'EQUITY', BX: 'EQUITY', GME: 'EQUITY', NVO: 'EQUITY', ASTS: 'EQUITY',
  USAR: 'EQUITY', LITE: 'EQUITY',
  SPY: 'EQUITY', QQQ: 'EQUITY', SP500: 'EQUITY', VIX: 'EQUITY',
  XLE: 'EQUITY', URNM: 'EQUITY',
  // ── KR_EQUITY: Korean/Japanese single-names + Asia indices/ETFs (weekend-level v1) ──
  SMSN: 'KR_EQUITY', SAMSUNG: 'KR_EQUITY', SKHX: 'KR_EQUITY', SKHYNIX: 'KR_EQUITY',
  HYUNDAI: 'KR_EQUITY', SOFTBANK: 'KR_EQUITY', KIOXIA: 'KR_EQUITY',
  JP225: 'KR_EQUITY', KR200: 'KR_EQUITY', EWY: 'KR_EQUITY', EWJ: 'KR_EQUITY',
  // ── COMMODITY (weekend-level v1) ──
  GOLD: 'COMMODITY', SILVER: 'COMMODITY', PLATINUM: 'COMMODITY', PALLADIUM: 'COMMODITY',
  COPPER: 'COMMODITY', NATGAS: 'COMMODITY', CL: 'COMMODITY', BRENTOIL: 'COMMODITY',
  BZ: 'COMMODITY', URANIUM: 'COMMODITY', ALUMINIUM: 'COMMODITY', TTF: 'COMMODITY',
  CORN: 'COMMODITY', WHEAT: 'COMMODITY',
  // ── PREMARKET / pre-IPO (no external market) ──
  ANTHROPIC: 'PREMARKET', OPENAI: 'PREMARKET', SPCX: 'PREMARKET', QNTX: 'PREMARKET',
};

// ── Funding interpretation notes (R4) ──

/** PREMARKET / pre-IPO funding is administratively fixed, not market-driven. */
export const FUNDING_NOTE_PREIPO =
  'Pre-IPO funding is fixed (+0.005%/8h on Binance) — not a sentiment signal.';

/** EQUITY / KR_EQUITY / COMMODITY perp funding lacks the crypto interest component. */
export const FUNDING_NOTE_TRADFI =
  'Equity-perp funding has 0% interest component and is structurally near-zero; small absolute values are normal.';
