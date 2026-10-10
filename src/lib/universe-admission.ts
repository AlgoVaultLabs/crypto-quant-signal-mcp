/**
 * universe-admission.ts — OPS-ALARM-SINGLE-DERIVATION-W1 CH2. ONE admission predicate for every
 * venue universe. PURE: declarations, predicates and parsers only — the status FETCH (I/O, cache,
 * budget) lives in `exchange-universe.ts`, the one module both universe derivations already share.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
 * The universe admitted contracts the venue itself had switched off, because neither derivation read
 * the venue's own status. Measured at R0 (2026-09-29): XT marks 339 of its 1,108 PERPETUAL∧state==0
 * contracts closed to new positions or past their `offTime` (EPT off since 2026-01-30, D since
 * 2026-06-17 — both still ranked on frozen tickers; CVP's frozen 24h volume of 27 trillion ranked it
 * FIRST in the XT scan universe); HTX's OI feed carries 20 contracts absent from its own
 * `swap_contract_info` (LRDS among them, OI 1.86e-5 > 0, so admitted); Aster lists 19 of 589 USDT
 * perps as SETTLING. The uncapped 1h–12h seed lanes evaluated every one of them on every fire, and
 * the book-liveness canary saw only the handful whose venue still prints flat bars.
 *
 * ── THE CONTRACT ────────────────────────────────────────────────────────────────────────────────
 *  * `ADMISSION_SOURCES` is `Record<ExchangeId, …>`: adding a venue without a declaration is a
 *    COMPILE error (pinned by a tsc test that removes one key and expects the build to fail).
 *  * EXPLICIT VENUE STATUS ONLY. Liquidity, staleness and book presence are REPORT-ONLY evidence and
 *    never exclude (ruling C1: a weekend-closed equity book is thin, not dead).
 *  * Every predicate decides only on DOCUMENTED or MEASURED values. An unknown value, or a declared
 *    field that is absent or unparseable, ADMITS the row and is counted `admission_field_absent` —
 *    failure goes toward the legacy universe, never toward an empty one.
 *  * `listing` kinds treat ABSENCE from the venue's own contract list as `venue_disabled` (HTX:
 *    "This contract doesnt exist" is how HTX answers for LRDS). Every other kind admits an absent row.
 *  * The venue circuit: one fetch excluding more than max(1.5 × the R0-measured share, 50%) of a
 *    venue's rows admits the legacy set instead and says ADMISSION_CIRCUIT_OPEN — an API change must
 *    never empty a lane.
 *  * `UNIVERSE_ADMISSION_MODE=enforce|legacy` (default enforce; anything else → legacy, loudly).
 *    `legacy` is byte-identical to the pre-wave code on BOTH derivations: the scan SoT keeps only
 *    HL's historical OI>0 filter (it is HL's declaration, `legacy_oi_positive`), the seed keeps none.
 *
 * The XT predicate is `openSwitch ∧ (offTime null ∨ future)`, NOT the spec's `tradeSwitch ∧ …`:
 * measured at R0, 11 XT index/commodity perps (AU200AUD, CORN, DE30EUR, …) carry
 * `tradeSwitch:false` with `openSwitch:true` and trade every hour, so `tradeSwitch` does not mean
 * "switched off" on XT. Every row the refined predicate removes printed zero traded bars in 24 h.
 */
import type { ExchangeId } from '../types.js';

export type AdmissionReason = 'admitted' | 'venue_disabled' | 'admission_field_absent';
export type AdmissionMode = 'enforce' | 'legacy';
export type AdmissionSide = 'sot' | 'seed';

/** One status record as parsed from the venue's own payload. */
export type StatusFields = Readonly<Record<string, unknown>>;
/** Venue symbol → status record. */
export type StatusMap = ReadonlyMap<string, StatusFields>;

interface StatusDeclaration {
  /** The venue endpoint carrying the status, or `null` when it is INLINE in the universe payload. */
  url: string | null;
  /** payload → symbol-keyed status. PURE; throws on an unrecognisable payload. */
  parse: (payload: unknown) => Map<string, StatusFields>;
  /** true = tradeable · false = the venue says off · null = field absent / unknown value. */
  isTradeable: (fields: StatusFields, nowMs: number) => boolean | null;
  /** The predicate in words — logged, and asserted by the tests. */
  describe: string;
  /** How long a fetched status stays valid in a long-lived process. Statuses change rarely. */
  cacheTtlMs: number;
  /** R0-measured exclusion share of this venue's universe, for the circuit. */
  measuredShare: number;
}

export type AdmissionSource =
  | ({ kind: 'flags' } & StatusDeclaration)
  | ({ kind: 'status_field' } & StatusDeclaration)
  | ({ kind: 'listing' } & StatusDeclaration)
  | { kind: 'legacy_oi_positive'; describe: string; measuredShare: number }
  | { kind: 'none'; reason: string }
  | { kind: 'retired'; reason: string };

export type StatusKind = Extract<AdmissionSource, { url: string | null }>;

/** A universe row as admission sees it. `symbol` is the VENUE's symbol (the status key). */
export interface AdmissionRow {
  symbol: string;
  notionalOI_usd?: number;
  volume24h_usd?: number;
  /** Only set by fetchers whose venue ships a book inline; undefined = not observable here. */
  hasBook?: boolean;
  /** Only set where the ticker payload carries its own timestamp (XT `t`, Aster/Binance `closeTime`). */
  tickerTsMs?: number;
  /** The canonical coin, where the caller knows it. IDENTITY ONLY — never an input to a decision; it
   *  rides into the admission record so a reader can join a decision to a `<venue>|<coin>` key. */
  coin?: string;
}

export interface AdmissionDecision { admit: boolean; reason: AdmissionReason }
/** One row beside the decision `admitRow` made for it — input order, in EVERY mode. */
export interface RowDecision<T extends AdmissionRow> { row: T; decision: AdmissionDecision }

export interface AdmissionTally {
  venue: ExchangeId;
  side: AdmissionSide;
  mode: AdmissionMode;
  kind: AdmissionSource['kind'];
  status: 'ok' | 'unavailable' | 'inline' | 'not_applicable';
  rows: number;
  admitted: number;
  excluded: number;
  venueDisabled: number;
  fieldAbsent: number;
  circuitOpen: boolean;
  tickerStale: number;
  noBook: number;
  zeroLiquidity: number;
}

const DAY_MS = 86_400_000;
const TEN_MIN = 600_000;
/** A ticker whose own timestamp is older than this is reported `ticker_stale` (evidence only). */
export const TICKER_STALE_MS = DAY_MS;
/** The circuit floor: whatever a venue measured, one fetch may never exclude more than this share. */
export const CIRCUIT_FLOOR_SHARE = 0.5;
export const CIRCUIT_MULTIPLE = 1.5;

// ── small, total parsers ─────────────────────────────────────────────────────────────────────────

function rowsAt(payload: unknown, path: string[]): Record<string, unknown>[] {
  let cur: unknown = payload;
  for (const k of path) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined;
  if (!Array.isArray(cur)) throw new Error(`status payload has no array at ${path.join('.') || '<root>'}`);
  return cur.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
}

function keyed(rows: Record<string, unknown>[], key: string, fields: string[]): Map<string, StatusFields> {
  const out = new Map<string, StatusFields>();
  for (const r of rows) {
    const k = r[key];
    if (typeof k !== 'string' || k.length === 0) continue;
    const f: Record<string, unknown> = {};
    for (const name of fields) if (name in r) f[name] = r[name];
    out.set(k, f);
  }
  return out;
}

/** An instant as ms: epoch ms, epoch seconds (< 1e11), or an ISO string. null when absent/unparseable. */
export function instantMs(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || v === 0) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return instantMs(Number(v));
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** A tri-state from an enumerated value: in `on` → true, in `off` → false, anything else → null. */
function enumerated(value: unknown, on: readonly unknown[], off: readonly unknown[]): boolean | null {
  if (on.includes(value)) return true;
  if (off.includes(value)) return false;
  return null;
}

// Binance-futures symbol status enum (Aster is a Binance fork and serves the same set).
const BINANCE_OFF = ['PENDING_TRADING', 'PRE_DELIVERING', 'DELIVERING', 'DELIVERED', 'PRE_SETTLE', 'SETTLING', 'CLOSE'] as const;

export const ADMISSION_SOURCES: Readonly<Record<ExchangeId, AdmissionSource>> = {
  HL: {
    kind: 'legacy_oi_positive',
    describe: 'notionalOI_usd > 0 (the pre-wave fetchHL filter; measured ≡ meta isDelisted, 56 of 234, mismatch 0)',
    measuredShare: 56 / 234,
  },
  BINANCE: {
    kind: 'status_field',
    url: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
    parse: (p) => keyed(rowsAt(p, ['symbols']), 'symbol', ['status', 'contractType']),
    isTradeable: (f) => enumerated(f.status, ['TRADING'], BINANCE_OFF),
    describe: "exchangeInfo status === 'TRADING'",
    cacheTtlMs: TEN_MIN,
    measuredShare: 0 / 732,
  },
  BYBIT: {
    kind: 'status_field',
    url: 'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000',
    parse: (p) => keyed(rowsAt(p, ['result', 'list']), 'symbol', ['status', 'contractType']),
    isTradeable: (f) => enumerated(f.status, ['Trading'], ['PreLaunch', 'Delivering', 'Closed']),
    describe: "instruments-info status === 'Trading'",
    cacheTtlMs: TEN_MIN,
    measuredShare: 0 / 784,
  },
  OKX: {
    kind: 'status_field',
    url: 'https://www.okx.com/api/v5/public/instruments?instType=SWAP',
    parse: (p) => keyed(rowsAt(p, ['data']), 'instId', ['state']),
    isTradeable: (f) => enumerated(f.state, ['live'], ['suspend', 'preopen', 'test']),
    describe: "public/instruments state === 'live'",
    cacheTtlMs: TEN_MIN,
    measuredShare: 0 / 478,
  },
  BITGET: {
    kind: 'status_field',
    url: 'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES',
    parse: (p) => keyed(rowsAt(p, ['data']), 'symbol', ['symbolStatus', 'offTime']),
    // The set is open-ended (Bitget documents normal / off / pre-launch "etc."): only those decide.
    isTradeable: (f) => enumerated(f.symbolStatus, ['normal'], ['off', 'pre-launch']),
    describe: "contracts symbolStatus === 'normal' (off / pre-launch exclude; any other value admits)",
    cacheTtlMs: TEN_MIN,
    measuredShare: 0 / 804,
  },
  ASTER: {
    kind: 'status_field',
    url: 'https://fapi.asterdex.com/fapi/v1/exchangeInfo',
    parse: (p) => keyed(rowsAt(p, ['symbols']), 'symbol', ['status', 'contractType']),
    isTradeable: (f) => enumerated(f.status, ['TRADING'], BINANCE_OFF),
    describe: "exchangeInfo status === 'TRADING'",
    cacheTtlMs: TEN_MIN,
    measuredShare: 19 / 589,
  },
  BINGX: {
    kind: 'status_field',
    url: 'https://open-api.bingx.com/openApi/swap/v2/quote/contracts',
    parse: (p) => keyed(rowsAt(p, ['data']), 'symbol', ['status']),
    // BingX documents 1 online · 25 no new positions · 5 pre-online · 0 offline.
    isTradeable: (f) => enumerated(f.status, [1], [0, 5, 25]),
    describe: 'quote/contracts status === 1 (0 offline · 5 pre-online · 25 no new positions exclude)',
    cacheTtlMs: TEN_MIN,
    measuredShare: 0 / 983,
  },
  GATE: {
    kind: 'flags',
    url: 'https://api.gateio.ws/api/v4/futures/usdt/contracts',
    parse: (p) => keyed(rowsAt(p, []), 'name', ['in_delisting', 'status']),
    isTradeable: (f) => {
      if (f.in_delisting === true) return false;
      const s = enumerated(f.status, ['trading'], ['delisting', 'delisted']);
      if (s !== null) return s;
      return f.in_delisting === false && f.status === undefined ? true : null;
    },
    describe: "contracts in_delisting === false ∧ status === 'trading'",
    cacheTtlMs: TEN_MIN,
    measuredShare: 0 / 1014,
  },
  HTX: {
    kind: 'listing',
    url: 'https://api.hbdm.com/linear-swap-api/v1/swap_contract_info',
    parse: (p) => keyed(rowsAt(p, ['data']), 'contract_code', ['contract_status']),
    // HTX documents 1 = listing; every other code is a non-trading state (delisting, pending,
    // suspension, settlement, delivery).
    isTradeable: (f) => (f.contract_status === 1 ? true : typeof f.contract_status === 'number' ? false : null),
    describe: 'present in swap_contract_info with contract_status === 1 (absent = venue_disabled)',
    cacheTtlMs: TEN_MIN,
    measuredShare: 20 / 379,
  },
  KUCOIN: {
    kind: 'status_field',
    url: null, // inline: contracts/active IS the universe payload
    parse: (p) => keyed(rowsAt(p, ['data']), 'symbol', ['status']),
    isTradeable: (f) => enumerated(f.status, ['Open'], ['BeingSettled', 'Settled', 'Paused', 'Closed', 'CancelOnly']),
    describe: "contracts/active status === 'Open' (inline, zero extra calls)",
    cacheTtlMs: TEN_MIN,
    measuredShare: 0 / 678,
  },
  MEXC: {
    kind: 'status_field',
    url: null, // inline: contract/detail is already fetched beside the ticker
    parse: (p) => keyed(rowsAt(p, ['data']), 'symbol', ['state']),
    isTradeable: (f) => enumerated(f.state, [0], [1, 2, 3, 4]),
    describe: 'contract/detail state === 0 (inline, zero extra calls)',
    cacheTtlMs: TEN_MIN,
    measuredShare: 0 / 1085,
  },
  PHEMEX: {
    kind: 'status_field',
    url: 'https://api.phemex.com/public/products',
    parse: (p) => keyed(rowsAt(p, ['data', 'perpProductsV2']), 'symbol', ['status']),
    isTradeable: (f) => enumerated(f.status, ['Listed'], ['Delisted']),
    describe: "public/products perpProductsV2 status === 'Listed'",
    cacheTtlMs: TEN_MIN,
    measuredShare: 0 / 124,
  },
  WHITEBIT: {
    kind: 'flags',
    url: 'https://whitebit.com/api/v4/public/markets',
    parse: (p) => keyed(rowsAt(p, []), 'name', ['tradesEnabled', 'delistedAt']),
    isTradeable: (f, now) => {
      if (f.tradesEnabled === false) return false;
      const off = instantMs(f.delistedAt);
      if (off !== null && off <= now) return false; // a FUTURE delistedAt is a schedule, not a switch-off
      return f.tradesEnabled === true ? true : null;
    },
    describe: 'markets tradesEnabled ∧ (delistedAt null ∨ future)',
    cacheTtlMs: TEN_MIN,
    measuredShare: 0 / 396,
  },
  XT: {
    kind: 'flags',
    url: 'https://fapi.xt.com/future/market/v1/public/symbol/list',
    parse: (p) => keyed(rowsAt(p, ['result']), 'symbol', ['openSwitch', 'tradeSwitch', 'offTime', 'contractType', 'state']),
    isTradeable: (f, now) => {
      const off = instantMs(f.offTime);
      if (off !== null && off <= now) return false;
      return typeof f.openSwitch === 'boolean' ? f.openSwitch : null;
    },
    describe: 'symbol/list openSwitch ∧ (offTime null ∨ future) — tradeSwitch is NOT an input (see header)',
    cacheTtlMs: TEN_MIN,
    measuredShare: 339 / 1108,
  },
  WEEX: {
    kind: 'none',
    reason: 'capi/v3/market/exchangeInfo carries no status / tradeStatus / openApiTrade field (measured 2026-09-29: 1,008 symbols, 0 status keys) — admitted as today',
  },
  BITMART: {
    kind: 'retired',
    reason: 'venues.status = retired since 2026-08-27; no scan-SoT fetcher; the seed lanes select --status promoted',
  },
  EDGEX: {
    kind: 'retired',
    reason: 'venues.status = retired since 2026-08-04; no scan-SoT fetcher; the seed lanes select --status promoted',
  },
};

export function isStatusKind(s: AdmissionSource): s is StatusKind {
  return s.kind === 'flags' || s.kind === 'status_field' || s.kind === 'listing';
}

/** The one decision for one row. PURE. */
export function admitRow(venue: ExchangeId, row: AdmissionRow, status: StatusMap | null, nowMs: number): AdmissionDecision {
  const decl = ADMISSION_SOURCES[venue];
  if (decl.kind === 'none' || decl.kind === 'retired') return { admit: true, reason: 'admitted' };
  if (decl.kind === 'legacy_oi_positive') {
    const oi = row.notionalOI_usd;
    if (typeof oi !== 'number' || !Number.isFinite(oi)) return { admit: true, reason: 'admission_field_absent' };
    return oi > 0 ? { admit: true, reason: 'admitted' } : { admit: false, reason: 'venue_disabled' };
  }
  if (status === null) return { admit: true, reason: 'admission_field_absent' };
  const fields = status.get(row.symbol);
  if (fields === undefined) {
    return decl.kind === 'listing'
      ? { admit: false, reason: 'venue_disabled' }
      : { admit: true, reason: 'admission_field_absent' };
  }
  let verdict: boolean | null;
  try {
    verdict = decl.isTradeable(fields, nowMs);
  } catch {
    verdict = null;
  }
  if (verdict === null) return { admit: true, reason: 'admission_field_absent' };
  return verdict ? { admit: true, reason: 'admitted' } : { admit: false, reason: 'venue_disabled' };
}

export function circuitShare(venue: ExchangeId): number {
  const decl = ADMISSION_SOURCES[venue];
  const measured = 'measuredShare' in decl ? decl.measuredShare : 0;
  return Math.max(CIRCUIT_MULTIPLE * measured, CIRCUIT_FLOOR_SHARE);
}

/** Whether a decision FILTERS: always under `enforce`; under `legacy` only HL's historical OI filter on
 *  the scan SoT. The one statement of it — `admitRows` filters by it, `classifyDeadBook` trusts by it. */
function admissionApplies(kind: AdmissionSource['kind'], mode: AdmissionMode, side: AdmissionSide): boolean {
  return mode === 'enforce' || (side === 'sot' && kind === 'legacy_oi_positive');
}

/**
 * Admit a venue's rows. PURE. Returns the rows to keep, the tally to log, and every row's decision.
 *
 * `legacy` is byte-identical to the pre-wave code per SIDE: the scan SoT keeps only
 * `legacy_oi_positive` (HL's historical filter), the seed keeps nothing.
 *
 * `decisions` (OPS-ALARM-OWNER-DERIVATION-W1 CH2) is computed in EVERY mode and never changes `rows`
 * or `tally`: the decision is the venue's answer, the mode only decides whether it filters. It is
 * what the dead-book canary reads instead of re-deriving the venue's status.
 */
export function admitRows<T extends AdmissionRow>(
  venue: ExchangeId, rows: readonly T[], status: StatusMap | null, nowMs: number,
  mode: AdmissionMode, side: AdmissionSide, statusState: AdmissionTally['status'],
): { rows: T[]; tally: AdmissionTally; decisions: RowDecision<T>[] } {
  const decl = ADMISSION_SOURCES[venue];
  const decisions = rows.map((row) => ({ row, decision: admitRow(venue, row, status, nowMs) }));
  const tally: AdmissionTally = {
    venue, side, mode, kind: decl.kind, status: statusState, rows: rows.length, admitted: 0, excluded: 0,
    venueDisabled: 0, fieldAbsent: 0, circuitOpen: false, tickerStale: 0, noBook: 0, zeroLiquidity: 0,
  };
  for (const r of rows) {
    if (typeof r.volume24h_usd === 'number' && !(r.volume24h_usd > 0)) tally.zeroLiquidity++;
    if (r.hasBook === false) tally.noBook++;
    if (typeof r.tickerTsMs === 'number' && nowMs - r.tickerTsMs > TICKER_STALE_MS) tally.tickerStale++;
  }
  if (!admissionApplies(decl.kind, mode, side)) {
    tally.admitted = rows.length;
    return { rows: [...rows], tally, decisions };
  }
  const kept: T[] = [];
  for (const { row: r, decision: d } of decisions) {
    if (d.reason === 'admission_field_absent') tally.fieldAbsent++;
    if (d.admit) kept.push(r);
    else tally.venueDisabled++;
  }
  // The circuit guards the NEW explicit-status sources only; HL's OI filter predates this wave and
  // stays byte-identical whatever its share.
  if (isStatusKind(decl) && rows.length > 0 && tally.venueDisabled / rows.length > circuitShare(venue)) {
    tally.circuitOpen = true;
    tally.admitted = rows.length;
    tally.excluded = 0;
    return { rows: [...rows], tally, decisions };
  }
  tally.admitted = kept.length;
  tally.excluded = rows.length - kept.length;
  return { rows: kept, tally, decisions };
}

export function formatAdmissionLine(t: AdmissionTally): string {
  return (
    `[universe-admission] ${t.venue} admitted ${t.admitted} excluded ${t.excluded} ` +
    `(venue_disabled ${t.circuitOpen ? 0 : t.venueDisabled} · field_absent ${t.fieldAbsent}) ` +
    `evidence(ticker_stale ${t.tickerStale} · no_book ${t.noBook} · zero_liquidity ${t.zeroLiquidity}) ` +
    `side=${t.side} mode=${t.mode} source=${t.kind} status=${t.status}` +
    (t.circuitOpen ? ` ADMISSION_CIRCUIT_OPEN would_exclude=${t.venueDisabled} of ${t.rows}` : '')
  );
}

/** The ONE mode resolver. Unrecognised → legacy, with a warning the caller must log. */
export function resolveAdmissionMode(raw: string | undefined): { mode: AdmissionMode; warning: string | null } {
  if (raw === undefined || raw === '' || raw === 'enforce') return { mode: 'enforce', warning: null };
  if (raw === 'legacy') return { mode: 'legacy', warning: null };
  return {
    mode: 'legacy',
    warning: `[universe-admission] UNIVERSE_ADMISSION_MODE=${JSON.stringify(raw)} is not enforce|legacy — resolving to LEGACY (fail toward today's universe)`,
  };
}

// ── the dead-book verdict (OPS-ALARM-OWNER-DERIVATION-W1 CH2) ────────────────────────────────────
//
// A dead book (suppressed by the emit gate on ≥ DEAD_BOOK_MIN_DAYS of the window) used to page with a
// paragraph asking a human to go and read the venue's contract status — a status this module
// ALREADY reads on every universe fetch. 9 of 9 Aster keys that ever entered the dead set were
// venue-LIVE: the gate was suppressing thin books correctly and each one paged anyway. The verdict
// below projects from admission's own decision; it never re-derives a venue's status.
//
// Precedence — first match wins:
//   1. STATUS_UNKNOWN        this run's admission cannot speak for the venue (fetch failed, no
//                            declaration, retired, no record, empty payload, not enforced, circuit
//                            open, status unavailable, field absent). Never resolves to VENUE_OFF.
//   2. VENUE_OFF             the venue's own status says off, or the coin is absent from a
//                            non-empty payload.
//   3. ADAPTER_CONTRADICTION the venue's ticker says it traded inside the window and the adapter's
//                            bars show no trade within ±1 bar of it.
//   4. THIN_LIVE             live and thin: the gate is right to suppress it. Report, never page.
//
// The trade test keys on the ticker's TIMESTAMP, never its volume (K3, measured 2026-10-10: Aster's
// 24 h ticker for EWT opened 10-05T05:20Z and closed 10-08T18:11:48Z with count 1 — the window is
// anchored at the LAST trade, so its "24 h volume" is days old and evidence of nothing).

export type DeadBookClass = 'STATUS_UNKNOWN' | 'VENUE_OFF' | 'ADAPTER_CONTRADICTION' | 'THIN_LIVE';
export type ContradictionCheck = 'consistent' | 'outside_window' | 'contradiction' | 'not_evaluable';

/** The evaluable window: the last 24 h of CLOSED bars (the still-open bar may not be served yet). */
export const DEAD_BOOK_TRADE_WINDOW_MS = DAY_MS;

export interface DeadBookInput {
  venue: ExchangeId;
  /** `admitRow`'s decision for the key's coin in THIS run's fetch; null = the coin is not in the payload. */
  decision: AdmissionDecision | null;
  /** The admission record's status state; null = no record of an admission in this run at all. */
  statusState: AdmissionTally['status'] | null;
  circuitOpen: boolean;
  mode: AdmissionMode;
  /** Rows the venue's universe payload carried in this run. */
  universeRows: number;
  /** The universe fetch threw (its message), else null. */
  fetchError: string | null;
  /** The venue ticker's own timestamp for the coin (anchored at the last trade where measured — K3). */
  venueLastTradeMs: number | null;
  /** Carried for the record and DELIBERATELY never read (K3). A test pins that it changes nothing. */
  volume24hUsd: number | null;
  /** The adapter's recent bars (open time ms, volume); null = the adapter could not be asked. */
  bars: ReadonlyArray<{ time: number; volume: number }> | null;
  barMs: number;
  nowMs: number;
}

export interface DeadBookVerdict {
  cls: DeadBookClass;
  reason: string;
  contradictionCheck: ContradictionCheck;
  /** Bars with volume > 0 inside the evaluable window; null when no bars were evaluated. */
  tradedBars24h: number | null;
}

const isoOf = (ms: number): string => new Date(ms).toISOString();

/** The ONE dead-book classifier. PURE. */
export function classifyDeadBook(i: DeadBookInput): DeadBookVerdict {
  const verdict = (cls: DeadBookClass, reason: string, contradictionCheck: ContradictionCheck = 'not_evaluable',
    tradedBars24h: number | null = null): DeadBookVerdict => ({ cls, reason, contradictionCheck, tradedBars24h });
  const unknown = (reason: string) => verdict('STATUS_UNKNOWN', reason);
  const decl = ADMISSION_SOURCES[i.venue];

  // 1. STATUS_UNKNOWN — an untrustworthy source never yields VENUE_OFF.
  if (i.fetchError !== null) return unknown(`the ${i.venue} universe fetch failed: ${i.fetchError}`);
  if (decl.kind === 'none') return unknown(`no venue status is declared for ${i.venue}: ${decl.reason}`);
  if (decl.kind === 'retired') return unknown(`${i.venue} is retired: ${decl.reason}`);
  if (i.statusState === null) return unknown(`no ${i.venue} admission record from this run`);
  if (i.universeRows === 0) return unknown(`the ${i.venue} universe payload was empty`);
  if (!admissionApplies(decl.kind, i.mode, 'sot')) return unknown(`UNIVERSE_ADMISSION_MODE=${i.mode}: the ${i.venue} status is not enforced`);
  if (i.circuitOpen) return unknown(`ADMISSION_CIRCUIT_OPEN on ${i.venue}: this fetch would exclude more than the circuit allows, so its status is not trusted`);
  if (i.statusState === 'unavailable') return unknown(`the ${i.venue} status source was unavailable`);
  if (i.decision !== null && i.decision.reason === 'admission_field_absent') {
    return unknown(`the ${i.venue} status field was absent or unparseable for this contract`);
  }

  // 2. VENUE_OFF — the venue's own answer.
  if (i.decision === null) return verdict('VENUE_OFF', `absent from ${i.venue}'s own universe payload (${i.universeRows} rows)`);
  if (!i.decision.admit) return verdict('VENUE_OFF', `${i.venue}'s own status switches it off (admitted only when ${decl.describe})`);

  // 3/4. Admitted: does the adapter see the market the venue says traded?
  if (i.bars === null) return verdict('THIN_LIVE', 'the adapter could not be asked for bars');
  const barMs = i.barMs;
  if (!(barMs > 0)) return verdict('THIN_LIVE', `no usable bar width (${barMs})`);
  const windowEnd = Math.floor(i.nowMs / barMs) * barMs;
  const windowStart = windowEnd - DEAD_BOOK_TRADE_WINDOW_MS;
  const traded = i.bars.filter((b) => b.volume > 0);
  const tradedBars24h = traded.filter((b) => b.time >= windowStart && b.time < windowEnd).length;
  const t = i.venueLastTradeMs;
  if (t === null || !Number.isFinite(t)) {
    return verdict('THIN_LIVE', `${i.venue}'s ticker carries no last-trade timestamp`, 'not_evaluable', tradedBars24h);
  }
  if (t < windowStart || t >= windowEnd) {
    return verdict('THIN_LIVE', `the venue's last trade ${isoOf(t)} is outside the evaluable window [${isoOf(windowStart)}, ${isoOf(windowEnd)})`,
      'outside_window', tradedBars24h);
  }
  const tradeBar = Math.floor(t / barMs) * barMs;
  if (traded.some((b) => Math.abs(b.time - tradeBar) <= barMs)) {
    return verdict('THIN_LIVE', `the venue's last trade ${isoOf(t)} falls within ±1 bar of a traded adapter bar`, 'consistent', tradedBars24h);
  }
  return verdict('ADAPTER_CONTRADICTION',
    `the venue traded at ${isoOf(t)}, inside the window, and the adapter's bars show no trade within ±1 bar (${i.bars.length} bars, ${tradedBars24h} traded)`,
    'contradiction', tradedBars24h);
}
