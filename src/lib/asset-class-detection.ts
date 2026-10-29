/**
 * asset-class-detection.ts — THE asset-class engine: the single source of truth for
 * "what asset class is (coin, venue)?".
 *
 * OPS-TIER-CLASSIFIER-XVENUE-W1 built it as the ONE derivation both
 * `asset-tiers.ts::classifyAsset` (tier display) and `underlying-type.ts::resolveAssetClass`
 * (session/funding) project from (Single-Derivation-Rule). It lives in its own low-level module
 * because `underlying-type` imports `isKnownTradFi` from `asset-tiers`, and `asset-tiers` imports
 * THIS — co-locating would form an init cycle. Never import asset-tiers / underlying-type /
 * tradfi-funding here; HL's xyz list comes through a dynamic import for the same reason.
 *
 * OPS-ASSET-CLASS-TOTALITY-W1 — every perp gets its class from its own venue's record:
 *  - RECORDS. Each field venue's detector returns one `{native, bare, flag, tag}` per listed
 *    instrument — crypto ones too, because a venue's own "this is crypto" is evidence.
 *  - ONE TAG TABLE. `VENUE_TAG_CLASS` (market-sessions-constants) maps venue → tag → class+level.
 *    A TradFi-flagged instrument with an unknown tag is never dropped: `TAG_PATTERNS` classes it
 *    and the ledger lists it as `unmapped`.
 *  - REFINEMENT. A level-1/0 tag (Bybit `stock`, Bitget `isRwa`) borrows the most specific level-2
 *    class another venue gives the same underlying — exact bare first, then `refineForms`. Refinement
 *    only ever picks a CLASS; it never decides TradFi vs crypto.
 *  - EXACT-FIRST. A coin on a field venue resolves through that venue's OWN record, reached by the
 *    adapter's own forward mapper (`to<Venue>Symbol`) — the instrument the adapter actually trades,
 *    so a ticker clash (Binance `CAT` = `1000CATUSDT`, not Caterpillar's `CATUSDT`; BingX `CVX` vs
 *    `NCSKCVX2USD`) cannot collide. A coin with no own record falls to the cross-venue union, where a
 *    field venue's EXACT crypto listing beats any TradFi one; only then may its de-tokenized query
 *    form decide TradFi (TSLAX → TSLA, ratified Q3). Storage-side form expansion is retired.
 *  - LEDGER. Every snapshot carries `ledger`: `unmapped`, `conflicts`, `lost`, `collisions` and the
 *    failed venues. `src/scripts/asset-class-totality.ts` builds its own snapshot from a live read of
 *    the active venues and turns that ledger into the daily canary's verdict.
 *
 * Degradation (unchanged): live snapshot → kept (stale) snapshot → STATIC_ASSET_CLASS_MAP floor.
 * Per-venue fail-open: one venue down never blocks classification. The read path is SYNC over the
 * pre-warmed snapshot so `classifyAsset` stays sync across its performance-db call-sites.
 *
 * TEST SEAMS: `_clearAssetClassCache()` · `_setDetectorsForTest(partial)` ·
 * `_loadVenueRecordsForTest(records)` · `_warmForTest()` · `_getAssetClassState()` ·
 * `_getAssetClassLedgerForTest()`. Real network is
 * never hit under vitest unless detectors are injected.
 */
import type { ExchangeId } from '../types.js';
import {
  STATIC_ASSET_CLASS_MAP,
  VENUE_TAG_CLASS,
  TAG_PATTERNS,
  ASSET_CLASS_TAXONOMY,
  type AssetClass,
  type FieldVenue,
  type TagClass,
  type TagLevel,
} from './market-sessions-constants.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS } from './adapters/_upstream-fetch.js';
import { toBinanceSymbol } from './adapters/binance.js';
import { toGateSymbol } from './adapters/gateio.js';
import { toMexcSymbol } from './adapters/mexc.js';
import { toBitgetSymbol } from './adapters/bitget.js';
import { toBybitSymbol } from './adapters/bybit.js';
import { toWhitebitSymbol } from './adapters/whitebit.js';
import { toBitmartSymbol } from './adapters/bitmart.js';
import { toBingxSymbol } from './adapters/bingx.js';
import { toOKXInstId } from './adapters/okx.js';

/**
 * Crypto tickers that collide with (or resemble) TradFi symbols — never Tier 3, whatever a venue
 * tags them. SPX (the SPX6900 memecoin, ≠ SP500 the index) needs no row: every field venue lists it
 * as crypto, and exact crypto evidence wins.
 */
const CRYPTO_DENYLIST: ReadonlySet<string> = new Set([
  // Ticker-collision crypto (spec C2 + the ...X majors the deToken guard also covers).
  'TNSR', 'Q', 'FIO', 'IDOL', 'ASTEROID', 'DYDX', 'APEX',
  'AVAX', 'FLUX', 'IMX', 'GMX',
  // Stablecoins — crypto, NEVER FX. A venue's forex tag must not tier USDC/USDT as
  // TradFi (C3 canary caught `USDC -> FX` live, 2026-06-21).
  'USDC', 'USDT', 'USDE', 'DAI', 'FDUSD', 'TUSD', 'USDD', 'PYUSD', 'USDP', 'GUSD', 'USDS', 'USD1', 'EURC', 'EURT',
  // Crypto tokens pegged to a commodity (gold) — crypto, NOT a commodity perp; the real
  // metal tickers (XAU/XAG/XPT/XPD) are unaffected (C3 canary caught XAUT/PAXG -> COMMODITY).
  'XAUT', 'PAXG',
]);

// ── Symbol forms ──

/**
 * Drop a tokenization marker to recover the underlying ticker: a trailing `STOCK`
 * (MEXC `SNDKSTOCK`/Bybit `AMDSTOCK`→`AMD`) or a trailing single `X` on a ≥4-char
 * base (`AAPLX`→`AAPL`, `MSTRX`→`MSTR`). The ≥4-char guard is deliberate: it leaves
 * the crypto majors that legitimately end in `X` intact (`DYDX`/`AVAX`/`FLUX`/`IMX`/
 * `GMX` all have <4 chars before the `X`), so a tokenized stock de-tokenizes but a
 * crypto coin does not.
 */
export function deToken(sym: string): string {
  let x = sym.replace(/STOCK$/, '');
  if (/^[A-Z0-9]{4,}X$/.test(x)) x = x.slice(0, -1);
  return x;
}

/**
 * REFINE_FORMS — the other spellings a bare may carry for the same underlying: de-token
 * (STOCK / X), the BingX NC wrapper (`NCSKTSLA2USD`→`TSLA`), Bitget's HKD line
 * (`TENCENTHKD`→`TENCENT`) and a USD pair leg (`JP225USD`→`JP225`). Used to pick a CLASS during
 * refinement, and — only for a coin with no own record and no exact crypto listing anywhere —
 * as the query-side TradFi decision (ratified Q3).
 */
export function refineForms(bare: string): string[] {
  const out: string[] = [];
  const add = (f: string | undefined): void => { if (f && f !== bare && !out.includes(f)) out.push(f); };
  add(deToken(bare));
  const nc = bare.match(/^NC(?:SK|SI|CO|FX)(.+?)2USD$/)?.[1];
  add(nc ?? bare.match(/^([A-Z0-9]{3,})USD$/)?.[1]); // a wrapper's own `2USD` is not a USD leg
  add(bare.match(/^([A-Z0-9]{2,})HKD$/)?.[1]);
  return out;
}

// ── Records ──

export type VenueFlag = 'TRADFI' | 'CRYPTO';

/** One listed instrument, as its own venue records it. */
export interface VenueRecord {
  /** The venue's own instrument id (`TSLAUSDT`, `TSLA-USDT-SWAP`, `NCSKTSLA2USD-USDT`, `xyz:TSLA`). */
  native: string;
  /** `native` minus the venue's quote suffix / dex prefix — nothing else is stripped (`NCSKTSLA2USD`, `EURUSD`). */
  bare: string;
  flag: VenueFlag;
  /** The venue's own discriminator value (`HK_EQUITY`, `stocks`, `3`, `isRwa`, ``). */
  tag: string;
}

/** A field venue's detector: every listed USDT perp it publishes. Throws on a failed fetch. */
export type VenueDetector = () => Promise<VenueRecord[]>;

interface VenueKeying {
  /** native → bare: strip the venue's quote suffix / dex prefix ONCE (the exchange-universe derivation). */
  bare: (native: string) => string;
  /** coin → the native instrument the venue's ADAPTER trades for it. Absent ⇒ the bare IS the coin. */
  native?: (coin: string) => string;
}

const VENUE_KEYING: Readonly<Record<FieldVenue, VenueKeying>> = {
  BINANCE: { bare: (s) => s.replace(/USDT$/, ''), native: toBinanceSymbol },
  GATE: { bare: (s) => s.replace(/_USDT$/, ''), native: toGateSymbol },
  MEXC: { bare: (s) => s.replace(/_USDT$/, ''), native: toMexcSymbol },
  BITGET: { bare: (s) => s.replace(/USDT$/, ''), native: toBitgetSymbol },
  BYBIT: { bare: (s) => s.replace(/USDT$/, ''), native: toBybitSymbol },
  WHITEBIT: { bare: (s) => s.replace(/_PERP$/, ''), native: toWhitebitSymbol },
  EDGEX: { bare: (s) => s.replace(/USD$/, '') },
  BITMART: { bare: (s) => s.replace(/USDT$/, ''), native: toBitmartSymbol },
  BINGX: { bare: (s) => s.replace(/-USDT$/, ''), native: toBingxSymbol },
  HL: { bare: (s) => s.replace(/^xyz:/i, '') },
  OKX: { bare: (s) => s.replace(/-USDT-SWAP$/, ''), native: toOKXInstId },
};

/** The field venues, in tag-table order — also the union's tie-break order. */
export const FIELD_VENUES: readonly FieldVenue[] = Object.keys(VENUE_TAG_CLASS) as FieldVenue[];

/**
 * Venues that publish no usable per-instrument class field — resolved through the cross-venue union
 * (decoding them is OPS-TIER-CLASSIFIER-DECODE-W2). Together with the field venues this must cover
 * every `ExchangeId`: tsc refuses a new venue that is neither (structural, not asserted).
 */
export const UNION_VENUES = ['ASTER', 'PHEMEX', 'XT', 'WEEX', 'HTX', 'KUCOIN'] as const satisfies readonly ExchangeId[];
type Unclassified = Exclude<ExchangeId, FieldVenue | (typeof UNION_VENUES)[number]>;
const _everyVenueClassified: [Unclassified] extends [never] ? true : Unclassified = true;
const _fieldVenuesAreExchanges: readonly ExchangeId[] = FIELD_VENUES;
void _everyVenueClassified; void _fieldVenuesAreExchanges;

export function isFieldVenue(v: string): v is FieldVenue {
  return Object.prototype.hasOwnProperty.call(VENUE_TAG_CLASS, v);
}

function tagEntry(venue: FieldVenue, tag: string): TagClass | 'CRYPTO' | undefined {
  const table = VENUE_TAG_CLASS[venue] as Readonly<Record<string, TagClass | 'CRYPTO'>>;
  return Object.prototype.hasOwnProperty.call(table, tag) ? table[tag] : undefined;
}

/** Build a record: the flag is the venue's own — its tag is crypto evidence in `VENUE_TAG_CLASS`, or it is TradFi. */
export function venueRecord(venue: FieldVenue, native: string, tag: string): VenueRecord {
  return {
    native,
    bare: VENUE_KEYING[venue].bare(native).toUpperCase(),
    flag: tagEntry(venue, tag) === 'CRYPTO' ? 'CRYPTO' : 'TRADFI',
    tag,
  };
}

// ── Detectors (one per field venue; each reads the venue's own per-instrument field) ──

function fetchVenue<T>(venue: ExchangeId, url: string): Promise<T> {
  return upstreamFetch<T>(VENUE_FETCH_CONFIGS[venue], { url });
}

/** MEXC zones, most specific first — the tag is the first one a contract carries. */
const MEXC_ZONES: readonly string[] = Object.keys(VENUE_TAG_CLASS.MEXC).filter((t) => t !== '');

const DETECTORS: Readonly<Record<FieldVenue, VenueDetector>> = {
  // Binance — contractType PERPETUAL (crypto) vs TRADIFI_PERPETUAL + underlyingType.
  BINANCE: async () => {
    const j = await fetchVenue<{ symbols?: Array<{ symbol?: string; contractType?: string; underlyingType?: string | null }> }>(
      'BINANCE', 'https://fapi.binance.com/fapi/v1/exchangeInfo');
    const out: VenueRecord[] = [];
    for (const s of j.symbols ?? []) {
      if (!s.symbol?.endsWith('USDT')) continue;
      if (s.contractType === 'PERPETUAL') out.push(venueRecord('BINANCE', s.symbol, 'PERPETUAL'));
      else if (s.contractType === 'TRADIFI_PERPETUAL') out.push(venueRecord('BINANCE', s.symbol, s.underlyingType ?? ''));
    }
    return out;
  },
  // Gate — contract_type ('' = crypto; stocks/indices/commodities/metals/forex).
  GATE: async () => {
    const arr = await fetchVenue<Array<{ name?: string; contract_type?: string }>>(
      'GATE', 'https://api.gateio.ws/api/v4/futures/usdt/contracts');
    return (arr ?? []).filter((c) => c.name?.endsWith('_USDT')).map((c) => venueRecord('GATE', c.name!, c.contract_type ?? ''));
  },
  // MEXC — typeLabel 2 or a tradfi zone marks TradFi; the tag is its most specific zone.
  MEXC: async () => {
    const j = await fetchVenue<{ data?: Array<{ symbol?: string; typeLabel?: number | string; conceptPlate?: string[] }> }>(
      'MEXC', 'https://contract.mexc.com/api/v1/contract/detail');
    const out: VenueRecord[] = [];
    for (const c of j.data ?? []) {
      if (!c.symbol?.endsWith('_USDT')) continue;
      const zones = (c.conceptPlate ?? []).map((z) => z.toLowerCase().replace(/^mc-trade-zone-/, ''));
      const tradfi = String(c.typeLabel) === '2' || zones.includes('tradfi');
      const tag = tradfi ? (MEXC_ZONES.find((z) => zones.includes(z)) ?? `zones:${zones.join(',')}`) : '';
      out.push(venueRecord('MEXC', c.symbol, tag));
    }
    return out;
  },
  // Bitget — isRwa === "YES" (binary; the class comes from refinement).
  BITGET: async () => {
    const j = await fetchVenue<{ data?: Array<{ symbol?: string; isRwa?: string }> }>(
      'BITGET', 'https://api.bitget.com/api/v2/mix/market/contracts?productType=usdt-futures');
    return (j.data ?? []).filter((c) => c.symbol?.endsWith('USDT')).map((c) => venueRecord('BITGET', c.symbol!, c.isRwa === 'YES' ? 'isRwa' : ''));
  },
  // Bybit — symbolType ('' / innovation = crypto; stock/ETF/commodity/forex); USDT perps; paginated.
  BYBIT: async () => {
    const out: VenueRecord[] = [];
    let cursor = '';
    for (let page = 0; page < 6; page++) {
      const url = `https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const j = await fetchVenue<{ result?: { list?: Array<{ symbol?: string; symbolType?: string; contractType?: string; quoteCoin?: string }>; nextPageCursor?: string } }>('BYBIT', url);
      const list = j.result?.list ?? [];
      for (const c of list) {
        if (c.contractType !== 'LinearPerpetual' || c.quoteCoin !== 'USDT' || !c.symbol) continue;
        out.push(venueRecord('BYBIT', c.symbol, c.symbolType ?? ''));
      }
      cursor = j.result?.nextPageCursor ?? '';
      if (!cursor || list.length === 0) break;
    }
    return out;
  },
  // WhiteBit — isTradFiFutures on the `_PERP` markets.
  WHITEBIT: async () => {
    const arr = await fetchVenue<Array<{ name?: string; isTradFiFutures?: boolean }>>(
      'WHITEBIT', 'https://whitebit.com/api/v4/public/markets');
    return (arr ?? []).filter((c) => c.name?.endsWith('_PERP'))
      .map((c) => venueRecord('WHITEBIT', c.name!, c.isTradFiFutures === true ? 'isTradFiFutures' : ''));
  },
  // EdgeX — isStock on data.contractList[] (retired venue; fails open).
  EDGEX: async () => {
    const j = await fetchVenue<{ data?: { contractList?: Array<{ contractName?: string; isStock?: boolean }> } }>(
      'EDGEX', 'https://pro.edgex.exchange/api/v1/public/meta/getMetaData');
    return (j.data?.contractList ?? []).filter((c) => c.contractName)
      .map((c) => venueRecord('EDGEX', c.contractName!, c.isStock === true ? 'isStock' : ''));
  },
  // BitMart — a non-empty tradfi_info object (retired venue; fails open).
  BITMART: async () => {
    const j = await fetchVenue<{ data?: { symbols?: Array<{ symbol?: string; tradfi_info?: unknown }> } }>(
      'BITMART', 'https://api-cloud-v2.bitmart.com/contract/public/details');
    return (j.data?.symbols ?? []).filter((c) => c.symbol?.endsWith('USDT'))
      .map((c) => venueRecord('BITMART', c.symbol!, c.tradfi_info ? 'tradfi_info' : ''));
  },
  // BingX — no field; the NC?? wrapper prefix is the venue's own TradFi marker.
  BINGX: async () => {
    const j = await fetchVenue<{ data?: Array<{ symbol?: string }> }>(
      'BINGX', 'https://open-api.bingx.com/openApi/swap/v2/quote/contracts');
    return (j.data ?? []).filter((c) => c.symbol?.endsWith('-USDT'))
      .map((c) => venueRecord('BINGX', c.symbol!, c.symbol!.match(/^(NC[A-Z]{2})/)?.[1] ?? ''));
  },
  // HL — the main dex is crypto; the xyz builder dex is TradFi. ONE `allPerpMetas` call (the sampler's
  // ≤ 1 HL call per run) returns every dex's universe as HL names it — `xyz:TSLA` arrives prefixed, so
  // the adapter alone names an HL market. Only the adapter's dexes (main, xyz) are records; dynamic
  // import keeps the cycle firewall.
  HL: async () => {
    const { hlInfoPost } = await import('./adapters/hyperliquid.js');
    const metas = await hlInfoPost<Array<{ universe?: Array<{ name?: string; isDelisted?: boolean }> }>>({ type: 'allPerpMetas' });
    const names = (Array.isArray(metas) ? metas : []).flatMap((m) => m.universe ?? [])
      .filter((u) => u.name && !u.isDelisted).map((u) => u.name!);
    const main = names.filter((n) => !n.includes(':'));
    const xyz = names.filter((n) => n.startsWith('xyz:'));
    if (main.length === 0) throw new Error('HL allPerpMetas returned no main universe');
    if (xyz.length === 0) throw new Error('HL allPerpMetas returned no xyz universe');
    return [...main.map((n) => venueRecord('HL', n, 'main')), ...xyz.map((n) => venueRecord('HL', n, 'xyz'))];
  },
  // OKX — instCategory (1 crypto · 3 stocks · 4 commodities) + ruleType pre_market; USDT-margined swaps.
  OKX: async () => {
    const j = await fetchVenue<{ data?: Array<{ instId?: string; instCategory?: string; ruleType?: string }> }>(
      'OKX', 'https://www.okx.com/api/v5/public/instruments?instType=SWAP');
    return (j.data ?? []).filter((c) => c.instId?.endsWith('-USDT-SWAP'))
      .map((c) => venueRecord('OKX', c.instId!, c.ruleType === 'pre_market' ? 'pre_market' : (c.instCategory ?? '')));
  },
};

// ── Snapshot ──

interface ResolvedRecord extends VenueRecord {
  venue: FieldVenue;
  /** CRYPTO for a crypto record; otherwise the refined TradFi class. */
  cls: AssetClass;
  /** The level of the venue's OWN tag (refinement never raises it). */
  level: TagLevel;
}

export interface VenueLedger {
  tradfi: number;
  crypto: number;
  /** TradFi instruments whose own coin does NOT resolve to their class — must be 0. */
  lost: number;
  /** Bares two listed instruments share on one venue — must be 0. */
  collisions: number;
  /** TradFi instruments no coin can reach: the adapter maps their bare to another instrument (Binance CATUSDT ← 1000CAT). */
  shadowed: number;
  /** TradFi-tagged instruments the crypto deny-list overrides (stablecoins, gold tokens). */
  denied: number;
}

export interface AssetClassLedger {
  probedAt: number;
  /** Field venues whose fetch failed this build. */
  failed: ExchangeId[];
  /** TradFi tags with no `VENUE_TAG_CLASS` row (classed by TAG_PATTERNS meanwhile). */
  unmapped: Array<{ venue: ExchangeId; tag: string; natives: string[] }>;
  /** Venues disagreeing about one underlying (the own record / first venue kept). */
  conflicts: Array<{ key: string; kind: 'level2' | 'refine' | 'crypto-vs-tradfi'; classes: Array<{ venue: ExchangeId; cls: AssetClass }> }>;
  lost: Array<{ venue: ExchangeId; native: string; expected: AssetClass; got: AssetClass | null }>;
  collisions: Array<{ venue: ExchangeId; bare: string; natives: string[] }>;
  venues: Partial<Record<ExchangeId, VenueLedger>>;
}

export interface AssetClassSnapshot {
  /** venue → own instrument id → record (own lookups through the adapter's forward mapper). */
  byNative: Map<FieldVenue, Map<string, ResolvedRecord>>;
  /** venue → bare → record (own lookups for venues without a forward mapper; collision check). */
  byBare: Map<FieldVenue, Map<string, ResolvedRecord>>;
  /** Bares some field venue lists as crypto. */
  exactCrypto: Set<string>;
  /** Bare → class of the first venue (tag-table order) listing it as TradFi. */
  exactTradFi: Map<string, AssetClass>;
  ledger: AssetClassLedger;
  probedAt: number;
}

const SNAPSHOT_TTL_MS = 60 * 60 * 1000; // 1h refresh cadence
let snapshot: AssetClassSnapshot | null = null;
let warmInflight: Promise<void> | null = null;
let detectorOverride: Partial<Record<FieldVenue, VenueDetector>> | null = null;

/** When the live snapshot was last (re)built. `null` until the first warm. */
export function assetClassProbedAt(): number | null {
  return snapshot?.probedAt ?? null;
}

const familyOf = (c: AssetClass) => ASSET_CLASS_TAXONOMY[c].family;

function staticSeed(keys: readonly string[]): AssetClass | null {
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(STATIC_ASSET_CLASS_MAP, k)) continue;
    const s = STATIC_ASSET_CLASS_MAP[k];
    if (s !== 'CRYPTO') return s;
  }
  return null;
}

/** Majority class among hits; a tie goes to the first hit (tag-table venue order). */
function pickClass(hits: ReadonlyArray<{ venue: FieldVenue; cls: AssetClass }>): AssetClass {
  const n = new Map<AssetClass, number>();
  for (const h of hits) n.set(h.cls, (n.get(h.cls) ?? 0) + 1);
  let best = hits[0].cls;
  for (const h of hits) if ((n.get(h.cls) ?? 0) > (n.get(best) ?? 0)) best = h.cls;
  return best;
}

/**
 * Pure: per-venue records → snapshot (tag → class, refinement, union, ledger). `failed` names the
 * field venues whose fetch failed; they simply contribute nothing.
 */
export function buildAssetClassSnapshot(
  records: Partial<Record<FieldVenue, readonly VenueRecord[]>>,
  failed: readonly ExchangeId[] = [],
  probedAt: number = Date.now(),
): AssetClassSnapshot {
  const ledger: AssetClassLedger = { probedAt, failed: [...failed], unmapped: [], conflicts: [], lost: [], collisions: [], venues: {} };
  const byNative = new Map<FieldVenue, Map<string, ResolvedRecord>>();
  const byBare = new Map<FieldVenue, Map<string, ResolvedRecord>>();
  const all: ResolvedRecord[] = [];

  // 1. Tag → class (never dropped: an unmapped TradFi tag goes through TAG_PATTERNS + the ledger).
  for (const venue of FIELD_VENUES) {
    const recs = records[venue];
    if (!recs) continue;
    const nat = new Map<string, ResolvedRecord>();
    const bar = new Map<string, ResolvedRecord>();
    const unmapped = new Map<string, string[]>();
    const vl: VenueLedger = { tradfi: 0, crypto: 0, lost: 0, collisions: 0, shadowed: 0, denied: 0 };
    for (const r of recs) {
      if (nat.has(r.native)) continue; // a venue listing the same instrument twice
      let cls: AssetClass = 'CRYPTO';
      let level: TagLevel = 2;
      if (r.flag === 'TRADFI') {
        const e = tagEntry(venue, r.tag);
        if (e && e !== 'CRYPTO') {
          ({ cls, level } = e);
        } else {
          const p = TAG_PATTERNS.find((x) => x.re.test(r.tag));
          cls = p?.cls ?? 'EQUITY';
          level = p ? 1 : 0;
          unmapped.set(r.tag, [...(unmapped.get(r.tag) ?? []), r.native]);
        }
        vl.tradfi++;
      } else {
        vl.crypto++;
      }
      const rr: ResolvedRecord = { ...r, venue, cls, level };
      nat.set(r.native, rr);
      const prior = bar.get(r.bare);
      if (prior) {
        vl.collisions++;
        ledger.collisions.push({ venue, bare: r.bare, natives: [prior.native, r.native] });
      } else {
        bar.set(r.bare, rr);
      }
      all.push(rr);
    }
    for (const [tag, natives] of unmapped) ledger.unmapped.push({ venue, tag, natives });
    byNative.set(venue, nat);
    byBare.set(venue, bar);
    ledger.venues[venue] = vl;
  }

  // 2. Refinement — every level-2 TradFi class indexed under its bare and its forms.
  const level2 = new Map<string, Array<{ venue: FieldVenue; cls: AssetClass }>>();
  for (const r of all) {
    if (r.flag !== 'TRADFI' || r.level !== 2) continue;
    for (const k of [r.bare, ...refineForms(r.bare)]) level2.set(k, [...(level2.get(k) ?? []), { venue: r.venue, cls: r.cls }]);
  }
  const conflictKeys = new Set<string>();
  const conflict = (key: string, kind: AssetClassLedger['conflicts'][number]['kind'], classes: Array<{ venue: ExchangeId; cls: AssetClass }>) => {
    if (conflictKeys.has(`${kind}:${key}`)) return;
    conflictKeys.add(`${kind}:${key}`);
    ledger.conflicts.push({ key, kind, classes });
  };
  for (const r of all) {
    if (r.flag !== 'TRADFI') continue;
    if (r.level === 2) {
      const others = (level2.get(r.bare) ?? []).filter((h) => h.venue !== r.venue && h.cls !== r.cls);
      if (others.length > 0) conflict(r.bare, 'level2', [{ venue: r.venue, cls: r.cls }, ...others]); // own wins
      continue;
    }
    const family = r.level === 1 ? familyOf(r.cls) : null;
    const keys = [r.bare, ...refineForms(r.bare)];
    let refined: AssetClass | null = null;
    for (const k of keys) {
      const hits = (level2.get(k) ?? []).filter((h) => h.venue !== r.venue && (family === null || familyOf(h.cls) === family));
      if (hits.length === 0) continue;
      refined = pickClass(hits);
      if (new Set(hits.map((h) => h.cls)).size > 1) conflict(k, 'refine', hits);
      break;
    }
    if (refined === null) {
      const seed = staticSeed(keys);
      if (seed && (family === null || familyOf(seed) === family)) refined = seed;
    }
    if (refined !== null) r.cls = refined;
  }

  // 3. The cross-venue union (no-own-record lookups).
  const exactCrypto = new Set<string>();
  const exactTradFi = new Map<string, AssetClass>();
  for (const r of all) {
    if (r.flag === 'CRYPTO') exactCrypto.add(r.bare);
    else if (!exactTradFi.has(r.bare)) exactTradFi.set(r.bare, r.cls);
  }
  for (const r of all) {
    if (r.flag === 'TRADFI' && exactCrypto.has(r.bare)) {
      conflict(r.bare, 'crypto-vs-tradfi', all.filter((x) => x.bare === r.bare).map((x) => ({ venue: x.venue, cls: x.cls })));
    }
  }

  const snap: AssetClassSnapshot = { byNative, byBare, exactCrypto, exactTradFi, ledger, probedAt };

  // 4. Lost — every reachable TradFi instrument must resolve, through its own coin, to its class.
  for (const r of all) {
    if (r.flag !== 'TRADFI') continue;
    const vl = ledger.venues[r.venue]!;
    if (isDenied(r.bare)) { vl.denied++; continue; }
    const toNative = VENUE_KEYING[r.venue].native;
    if (toNative && toNative(r.bare) !== r.native) { vl.shadowed++; continue; }
    const got = classifyIn(snap, r.bare, r.venue);
    if (got !== r.cls) {
      vl.lost++;
      ledger.lost.push({ venue: r.venue, native: r.native, expected: r.cls, got });
    }
  }
  return snap;
}

/** The deny-list names exact crypto tickers; a form of one (Binance's own EQUITY `USDEX`) is not denied. */
function isDenied(sym: string): boolean {
  return CRYPTO_DENYLIST.has(sym);
}

function ownRecord(s: AssetClassSnapshot, venue: ExchangeId, sym: string): ResolvedRecord | undefined {
  if (!isFieldVenue(venue)) return undefined;
  const toNative = VENUE_KEYING[venue].native;
  return toNative ? s.byNative.get(venue)?.get(toNative(sym)) : s.byBare.get(venue)?.get(sym);
}

function classifyIn(s: AssetClassSnapshot, sym: string, venue?: ExchangeId): AssetClass | null {
  if (isDenied(sym)) return 'CRYPTO';
  const own = venue ? ownRecord(s, venue, sym) : undefined;
  if (own) return own.cls;                       // the venue's own record decides
  if (s.exactCrypto.has(sym)) return 'CRYPTO';   // exact crypto evidence anywhere beats any TradFi
  const forms = refineForms(sym).filter((f) => !isDenied(f));
  for (const k of [sym, ...forms]) {             // exact TradFi, then the query-side form (Q3)
    const c = s.exactTradFi.get(k);
    if (c) return c;
  }
  return staticSeed([sym, ...forms]);
}

/**
 * Warm the asset-class snapshot (async). Called from `asset-tiers.ts::warmTierCaches` at boot and
 * on the 1h cadence. Per-venue fail-open; a build that found nothing keeps the prior (stale)
 * snapshot. NEVER hits the network under vitest unless detectors are injected.
 */
export async function warmAssetClasses(): Promise<void> {
  if (snapshot && Date.now() - snapshot.probedAt < SNAPSHOT_TTL_MS) return;
  if (!detectorOverride && process.env.VITEST) return;
  if (warmInflight) return warmInflight;
  warmInflight = (async () => {
    try {
      const { records, failed } = await collectVenueRecords();
      const next = buildAssetClassSnapshot(records, failed);
      if (next.exactTradFi.size > 0 || next.exactCrypto.size > 0 || !snapshot) snapshot = next;
    } catch (e) {
      console.warn(`[asset-class] warm failed (keeping prior snapshot): ${e instanceof Error ? e.message : e}`);
    } finally {
      warmInflight = null;
    }
  })();
  return warmInflight;
}

/**
 * Fetch every field venue's records (in parallel), skipping `skip` (retired venues). A venue whose
 * fetch throws is listed in `failed` and contributes nothing — never blocks the others.
 */
export async function collectVenueRecords(
  skip: ReadonlySet<string> = new Set(),
): Promise<{ records: Partial<Record<FieldVenue, VenueRecord[]>>; failed: FieldVenue[] }> {
  const detectors: Partial<Record<FieldVenue, VenueDetector>> = detectorOverride ?? DETECTORS;
  const venues = FIELD_VENUES.filter((v) => detectors[v] && !skip.has(v));
  const results = await Promise.allSettled(venues.map((v) => detectors[v]!()));
  const records: Partial<Record<FieldVenue, VenueRecord[]>> = {};
  const failed: FieldVenue[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') records[venues[i]] = r.value;
    else {
      failed.push(venues[i]);
      console.debug(`[asset-class] ${venues[i]} detector failed (fail-open): ${r.reason instanceof Error ? r.reason.message : r.reason}`);
    }
  });
  return { records, failed };
}

/**
 * SYNC: the AssetClass of a coin on a venue — `'CRYPTO'` when there is crypto evidence (the
 * venue's own record, an exact crypto listing elsewhere, the deny-list), a TradFi class when there
 * is TradFi evidence, `null` when nothing knows the coin. Reads the pre-warmed snapshot (cold ⇒ the
 * STATIC seed floor). Never throws. With no venue, only the cross-venue union applies.
 */
export function getAssetClass(coin: string, venue?: ExchangeId): AssetClass | null {
  const sym = String(coin).toUpperCase().trim();
  if (!snapshot) return isDenied(sym) ? 'CRYPTO' : staticSeed([sym, ...refineForms(sym).filter((f) => !isDenied(f))]);
  return classifyIn(snapshot, sym, venue);
}

/** Pure: `getAssetClass` against a GIVEN snapshot — the census/check path (serving reads the warm one). */
export function assetClassIn(snap: AssetClassSnapshot, coin: string, venue?: ExchangeId): AssetClass | null {
  return classifyIn(snap, String(coin).toUpperCase().trim(), venue);
}

/** SYNC: the TradFi class of a coin on a venue, or null when it is crypto / unknown (`classifyAsset`'s read). */
export function getTradFiClass(coin: string, venue?: ExchangeId): AssetClass | null {
  const c = getAssetClass(coin, venue);
  return c === null || c === 'CRYPTO' ? null : c;
}

// ── Test seams (never call in production) ──

/** Test-only: the serving snapshot's ledger, or null before the first warm. */
export function _getAssetClassLedgerForTest(): AssetClassLedger | null {
  return snapshot?.ledger ?? null;
}

/** Test-only: build the snapshot NOW from the active detectors, bypassing the env + TTL guards. */
export async function _warmForTest(): Promise<void> {
  const { records, failed } = await collectVenueRecords();
  snapshot = buildAssetClassSnapshot(records, failed);
}

/** Full reset: snapshot + inflight + detector overrides. */
export function _clearAssetClassCache(): void {
  snapshot = null;
  warmInflight = null;
  detectorOverride = null;
}

/** Inject per-venue detectors (or `null` to restore the live registry); drops the current snapshot. */
export function _setDetectorsForTest(partial: Partial<Record<FieldVenue, VenueDetector>> | null): void {
  detectorOverride = partial;
  snapshot = null;
}

/**
 * Test-only: install venue records as `[native, tag]` pairs — synchronously as the snapshot, and as
 * the detectors a later warm would read.
 */
export function _loadVenueRecordsForTest(pairs: Partial<Record<FieldVenue, ReadonlyArray<readonly [string, string]>>>): void {
  const records: Partial<Record<FieldVenue, VenueRecord[]>> = {};
  for (const v of Object.keys(pairs) as FieldVenue[]) records[v] = pairs[v]!.map(([n, t]) => venueRecord(v, n, t));
  detectorOverride = Object.fromEntries(Object.entries(records).map(([v, r]) => [v, async () => r])) as Partial<Record<FieldVenue, VenueDetector>>;
  snapshot = buildAssetClassSnapshot(records);
}

/** Read-only inspector: snapshot presence, age, union sizes, venues. */
export function _getAssetClassState(): { warm: boolean; ageMs: number | null; unionSize: number; venues: number } {
  return {
    warm: snapshot !== null,
    ageMs: snapshot ? Date.now() - snapshot.probedAt : null,
    unionSize: snapshot ? snapshot.exactTradFi.size : 0,
    venues: snapshot?.byNative.size ?? 0,
  };
}
