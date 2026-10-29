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

/**
 * The underlying asset classes we session/tier-classify. CRYPTO = 24/7.
 * INDEX + FX added by OPS-TIER-CLASSIFIER-XVENUE-W1 (Gate `indices`/`forex`, BingX
 * `NCSI`/`NCFX`, MEXC index/forex zones); HK_EQUITY + CN_EQUITY by
 * OPS-ASSET-CLASS-TOTALITY-W1 (Binance `underlyingType`). Every non-CRYPTO class ⇒ Tier 3.
 */
export type AssetClass =
  | 'CRYPTO' | 'EQUITY' | 'KR_EQUITY' | 'HK_EQUITY' | 'CN_EQUITY'
  | 'COMMODITY' | 'INDEX' | 'FX' | 'PREMARKET';

/** The family a class belongs to — what the `assetClass` scan filters and the funding note read. */
export type AssetFamily = 'CRYPTO' | 'EQUITY' | 'COMMODITY' | 'INDEX' | 'FX' | 'PREMARKET';
/** Which underlying-session model `classifyUnderlyingSession` applies. UNMODELED ⇒ no claim (UNKNOWN). */
export type SessionModel = 'ALWAYS_OPEN' | 'US_EQUITY' | 'WEEKEND_LEVEL' | 'UNMODELED' | 'PREIPO';
/** Which cross-venue funding path `get_market_regime` takes. */
export type FundingModel = 'CRYPTO_XVENUE' | 'TRADFI_AGGREGATE' | 'FIXED_PREIPO';

export interface AssetClassTraits {
  family: AssetFamily;
  session: SessionModel;
  funding: FundingModel;
}

/**
 * THE taxonomy (OPS-ASSET-CLASS-TOTALITY-W1). Every consumer — scan filters, session model,
 * funding path, funding note — derives from this one table, so a new class is ONE row and
 * tsc refuses a class without one. Key ORDER is data: it drives the public docs cell and
 * every derived list (`ASSET_CLASSES`), pinned by `tests/unit/asset-class-taxonomy.test.ts`.
 * The traits reproduce the pre-wave behaviour exactly; HK/CN_EQUITY take KR_EQUITY's.
 */
export const ASSET_CLASS_TAXONOMY: Readonly<Record<AssetClass, AssetClassTraits>> = {
  CRYPTO:    { family: 'CRYPTO',    session: 'ALWAYS_OPEN',   funding: 'CRYPTO_XVENUE' },
  EQUITY:    { family: 'EQUITY',    session: 'US_EQUITY',     funding: 'TRADFI_AGGREGATE' },
  KR_EQUITY: { family: 'EQUITY',    session: 'WEEKEND_LEVEL', funding: 'TRADFI_AGGREGATE' },
  HK_EQUITY: { family: 'EQUITY',    session: 'WEEKEND_LEVEL', funding: 'TRADFI_AGGREGATE' },
  CN_EQUITY: { family: 'EQUITY',    session: 'WEEKEND_LEVEL', funding: 'TRADFI_AGGREGATE' },
  COMMODITY: { family: 'COMMODITY', session: 'WEEKEND_LEVEL', funding: 'TRADFI_AGGREGATE' },
  INDEX:     { family: 'INDEX',     session: 'UNMODELED',     funding: 'CRYPTO_XVENUE' },
  FX:        { family: 'FX',        session: 'UNMODELED',     funding: 'CRYPTO_XVENUE' },
  PREMARKET: { family: 'PREMARKET', session: 'PREIPO',        funding: 'FIXED_PREIPO' },
};

/** Every class, in taxonomy order. */
export const ASSET_CLASSES: readonly AssetClass[] = Object.keys(ASSET_CLASS_TAXONOMY) as AssetClass[];

/** The traits of a resolved class, or null for UNKNOWN (the resolver could not substantiate one). */
export function assetClassTraits(cls: AssetClass | 'UNKNOWN'): AssetClassTraits | null {
  return cls === 'UNKNOWN' ? null : ASSET_CLASS_TAXONOMY[cls];
}

/** Every class whose family is in `families`, in taxonomy order. */
export function classesInFamilies(families: readonly AssetFamily[]): AssetClass[] {
  return ASSET_CLASSES.filter((c) => families.includes(ASSET_CLASS_TAXONOMY[c].family));
}

/** Every TradFi family (all but CRYPTO), in taxonomy order. */
export const TRADFI_FAMILIES: readonly AssetFamily[] = [
  ...new Set(ASSET_CLASSES.map((c) => ASSET_CLASS_TAXONOMY[c].family)),
].filter((f) => f !== 'CRYPTO');

// ── Venue tag table (OPS-ASSET-CLASS-TOTALITY-W1 CH1) ──

/**
 * How much a venue's tag says. 2 = class AND market (Binance `HK_EQUITY`, Gate `forex`);
 * 1 = family only (Bybit `stock` — which market is unknown); 0 = TradFi, class unknown
 * (Bitget `isRwa`). Refinement may fill in what a level < 2 tag leaves open.
 */
export type TagLevel = 0 | 1 | 2;
export interface TagClass { cls: AssetClass; level: TagLevel }

/**
 * venue → its own tag → `{cls, level}`, or `'CRYPTO'` for the venue's crypto evidence. The ONE
 * tag table: it replaces the per-detector inline maps and the old Binance-only
 * `BINANCE_UNDERLYING_TO_ASSET_CLASS`. A TradFi-flagged instrument whose tag is NOT here is never
 * dropped: `TAG_PATTERNS` classes it and the ledger lists it as `unmapped` until a row is added.
 * Live-probed 2026-10-29 (OKX codes: OKX API changelog 2026-04-10).
 */
export const VENUE_TAG_CLASS = {
  BINANCE: {
    PERPETUAL: 'CRYPTO',
    EQUITY: { cls: 'EQUITY', level: 2 },
    KR_EQUITY: { cls: 'KR_EQUITY', level: 2 },
    HK_EQUITY: { cls: 'HK_EQUITY', level: 2 },
    CN_EQUITY: { cls: 'CN_EQUITY', level: 2 },
    COMMODITY: { cls: 'COMMODITY', level: 2 },
    INDEX: { cls: 'INDEX', level: 2 },
    FX: { cls: 'FX', level: 2 },
    PREMARKET: { cls: 'PREMARKET', level: 2 },
  },
  GATE: {
    '': 'CRYPTO',
    stocks: { cls: 'EQUITY', level: 1 },
    indices: { cls: 'INDEX', level: 2 },
    commodities: { cls: 'COMMODITY', level: 2 },
    metals: { cls: 'COMMODITY', level: 2 },
    forex: { cls: 'FX', level: 2 },
  },
  // MEXC: the tag is the first `mc-trade-zone-*` zone in this row order that the contract carries.
  MEXC: {
    '': 'CRYPTO',
    commodities: { cls: 'COMMODITY', level: 2 },
    metals: { cls: 'COMMODITY', level: 2 },
    metalsfutures: { cls: 'COMMODITY', level: 2 },
    forex: { cls: 'FX', level: 2 },
    stockindex: { cls: 'INDEX', level: 2 },
    hkstocks: { cls: 'HK_EQUITY', level: 2 },
    usstocks: { cls: 'EQUITY', level: 2 },
    jpstocks: { cls: 'EQUITY', level: 1 },
    twstocks: { cls: 'EQUITY', level: 1 },
    etf: { cls: 'EQUITY', level: 1 },
    stock: { cls: 'EQUITY', level: 1 },
    tradfi: { cls: 'EQUITY', level: 0 },
  },
  BITGET: { '': 'CRYPTO', isRwa: { cls: 'EQUITY', level: 0 } },
  BYBIT: {
    '': 'CRYPTO',
    innovation: 'CRYPTO',
    stock: { cls: 'EQUITY', level: 1 },
    ETF: { cls: 'EQUITY', level: 1 },
    commodity: { cls: 'COMMODITY', level: 2 },
    forex: { cls: 'FX', level: 2 },
  },
  WHITEBIT: { '': 'CRYPTO', isTradFiFutures: { cls: 'EQUITY', level: 0 } },
  EDGEX: { '': 'CRYPTO', isStock: { cls: 'EQUITY', level: 1 } },
  BITMART: { '': 'CRYPTO', tradfi_info: { cls: 'EQUITY', level: 0 } },
  BINGX: {
    '': 'CRYPTO',
    NCSK: { cls: 'EQUITY', level: 1 },
    NCSI: { cls: 'INDEX', level: 2 },
    NCCO: { cls: 'COMMODITY', level: 2 },
    NCFX: { cls: 'FX', level: 2 },
  },
  HL: { main: 'CRYPTO', xyz: { cls: 'EQUITY', level: 0 } },
  // OKX `instCategory` (1 Crypto · 3 Stocks · 4 Commodities) + `ruleType: pre_market`. Codes 5/6
  // (Forex/Bonds per the changelog) are not live; one that appears lands via TAG_PATTERNS + `unmapped`.
  OKX: {
    '': 'CRYPTO',
    '1': 'CRYPTO',
    '3': { cls: 'EQUITY', level: 1 },
    '4': { cls: 'COMMODITY', level: 2 },
    pre_market: { cls: 'PREMARKET', level: 2 },
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, TagClass | 'CRYPTO'>>>>;

/** The venues that publish their own per-instrument TradFi record. */
export type FieldVenue = keyof typeof VENUE_TAG_CLASS;

/**
 * Never-dropped fallback for a TradFi-flagged instrument whose tag has no `VENUE_TAG_CLASS` row:
 * first match wins (family-level), else level 0 (TradFi, class left to refinement). The instrument
 * also lands in the ledger's `unmapped[]`, so the daily canary asks for the row.
 */
export const TAG_PATTERNS: ReadonlyArray<{ re: RegExp; cls: AssetClass }> = [
  { re: /_EQUITY$|STOCK|ETF/i, cls: 'EQUITY' },
  { re: /COMMOD|METAL|ENERGY/i, cls: 'COMMODITY' },
  { re: /FOREX|^FX$/i, cls: 'FX' },
  { re: /INDEX|INDIC/i, cls: 'INDEX' },
  { re: /PRE.?IPO|PRE.?MARKET/i, cls: 'PREMARKET' },
];

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
 * Static Tier-3 fallback: canonical AlgoVault coin symbol → AssetClass.
 *
 * The asset-class engine's seed floor: read when no venue snapshot is warm, when
 * no venue lists the coin at all, and as the last refinement source for a venue
 * tag that names no class (HL xyz). A symbol absent here with no venue evidence
 * resolves to `UNKNOWN` (renders NO caveat) — fail-safe: we never assert a
 * session state we can't substantiate.
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
  USAR: 'EQUITY', LITE: 'EQUITY', GLW: 'EQUITY', // GLW (Corning): OPS-TIER-CLASSIFIER-XVENUE-W1 verified canonical (venue-less seed)
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
