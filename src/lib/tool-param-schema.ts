/**
 * tool-param-schema.ts — DOCS-PARAM-SCHEMA-PROJECTION-W1 R2.
 *
 * THE ONE declaration of every ENUM-valued public tool parameter, and of the schema default
 * beside it. The Zod enums in `src/index.ts` / `src/tools/scan-trade-calls.ts` project from here,
 * and so does the `/docs` parameter table (`scripts/build_docs.mjs` reads
 * `dist/lib/tool-param-schema.js`). One edit, and the served schema and the published table move
 * together.
 *
 * WHY THIS EXISTS. `/docs` told integrators `get_trade_call` accepted FIVE venues. `tools/list`
 * published SEVENTEEN, on the same host, on every request — a 70% under-report of the cross-venue
 * differentiator, and a live correctness trap (`exchange: "WHITEBIT"` is valid; the page implied
 * it was not). Measured the same day: the page also declared `scan_trade_calls`'s timeframe
 * default as `1h` while the served schema defaulted to `15m`, so a caller omitting it silently
 * got different candles than documented. The table was hand-written, so it could only ever be as
 * fresh as the last person who remembered it.
 *
 * This is the THIRD instance of that generator — a hand-authored claim about system behaviour
 * with no executable counterpart — after AUTH-THREE-STATE-W1 (a docblock promising a route that
 * did not exist) and DOCS-SAMPLE-EXECUTABLE-W1 (a handshake CI had been asserting away on every
 * deploy). CLAUDE.md build-and-runtime: "after the 3rd same-class fix the 4th MUST build a gate
 * making the bug class structurally impossible." Retyping the list is not that gate — it drifts
 * again on venue 18. Projection is.
 *
 * ── WHY A NEW MODULE AND NOT `capabilities.ts` ────────────────────────────────
 * `EXCHANGES` there is the PROMOTED set (15) — venues that have accrued a public track record,
 * and exactly the set `/api/performance-public.exchange_count` reports. It is already
 * single-derived and has not drifted: `PROMOTED_VENUE_IDS` → `ScanExchangeId` →
 * `SCAN_TRADE_CALLS_SCHEMA.exchange` → the x402 bazaar enum, all projections. The ACCEPTED set
 * (17 — the promoted 15 plus EDGEX and WEEX) had no runtime declaration at all, so it was copied
 * by hand into four places: `src/index.ts` ×3 and `x402-bazaar.ts`'s `VENUE_ENUM`, whose own
 * docblock calls itself a mirror.
 *
 * That asymmetry IS the bug, and it is the argument for this file: the set that was PROJECTED
 * stayed correct through two venue expansions, the set that was COPIED under-reported by 12. Two
 * genuinely different questions — "which venues have a track record" vs "which venues may I
 * pass" — so two declarations, but both of them single.
 *
 * ── ORDER IS PART OF THE PUBLISHED CONTRACT ───────────────────────────────────
 * `VENUE_IDS_ALL` is in the exact order the live `tools/list` enum already emits, NOT in
 * `EXCHANGES` order. Deriving it from `EXCHANGES` + the two unpromoted ids would have reordered
 * the published JSON Schema for no reason. A projection that changes bytes it did not mean to
 * change is a worse gate than the copy it replaced.
 *
 * ── TIMEFRAMES ARE DELIBERATELY NOT RE-HOMED HERE ─────────────────────────────
 * `capabilities.TIMEFRAMES` is already the SoT for the 11-timeframe set, and
 * `tests/unit/capabilities.test.ts` guards it by REGEX-EXTRACTING the Zod enum literal out of
 * `src/index.ts` — it matches the FIRST `timeframe: z.enum([…])` in the file, which is
 * `get_trade_call`'s. Replacing that literal with a symbol breaks the guard: it finds no match and
 * fails on `expect(m).not.toBeNull()` — loudly, to its credit, but it still stops guarding. Worse,
 * replacing only that one hands first-match position to the regime tool's 3-value enum, so the
 * guard would then compare a deliberate subset against the full set and red on correct code. So
 * the full timeframe enum keeps its literal form at the `get_trade_call` Zod site, and this module
 * re-exports the SoT array for the docs projection. The 3-value regime subset had no prior home
 * and is declared here.
 */

import type { ExchangeId } from '../types.js';
import { TIMEFRAMES, PROMOTED_VENUE_IDS, type PromotedVenueId } from './capabilities.js';

/**
 * Every venue that has an ADAPTER — the declared set. NOT the set the public API accepts.
 *
 * Three tiers, and conflating any two of them is how `/docs` came to advertise a retired venue:
 *
 *   `ExchangeId`        an adapter exists                        (type-level, 17)
 *   `VENUE_IDS_ALL`     declared here                            (runtime, 17 — this array)
 *   `PUBLIC_VENUE_IDS`  promoted → accepted → documented         (runtime, 15 — below)
 *
 * EDGEX and WEEX live in the gap. Both have working adapters and both are still SEEDED, so their
 * history is not orphaned; neither is publicly callable. Order is the published `tools/list` enum
 * order, which is load-bearing — see the header.
 *
 * _(Corrected 2026-08-19 DOCS-SUPPORT-ANSWERS-AND-PUBLIC-VENUE-SCOPE-W1. This previously read
 * "EDGEX and WEEX have adapters and are accepted", which was true when written and became false
 * the moment the public enums narrowed. A docblock asserting a fact about a sibling declaration
 * is the same hand-authored claim this module exists to retire, one level up.)_
 */
export const VENUE_IDS_ALL = [
  'HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'ASTER', 'EDGEX', 'GATE', 'MEXC',
  'KUCOIN', 'PHEMEX', 'BINGX', 'HTX', 'WEEX', 'BITMART', 'XT', 'WHITEBIT',
] as const;

/**
 * COMPILE-TIME set equality with `ExchangeId`, both directions.
 *
 * `ExchangeId` is a type, so it is erased at runtime and cannot itself be the projection source.
 * These two assertions make the pair inseparable anyway: adding an `ExchangeId` without adding it
 * here (or vice versa) is a `tsc` error, not a docs bug found in production six weeks later.
 */
type _AllVenuesAreExchangeIds = (typeof VENUE_IDS_ALL)[number] extends ExchangeId ? true : never;
type _AllExchangeIdsAreVenues = ExchangeId extends (typeof VENUE_IDS_ALL)[number] ? true : never;
const _venueIdsCoverExchangeId: _AllVenuesAreExchangeIds = true;
const _exchangeIdCoversVenueIds: _AllExchangeIdsAreVenues = true;
void _venueIdsCoverExchangeId;
void _exchangeIdCoversVenueIds;

/**
 * The venues the PUBLIC API accepts — and therefore the only ones `/docs` may name.
 *
 * WHY THIS EXISTS. `DOCS-PARAM-SCHEMA-PROJECTION-W1` projected `VENUE_IDS_ALL` into the published
 * parameter tables, so `/docs` began advertising **EDGEX** (`venue_status: retired`, klines
 * ~200×timeframe stale, WR 25.2% — `INVESTIGATE-EDGEX-WR-W1`) and **WEEX** (`shadow`) as
 * selectable. A reader picking EDGEX off the table got a stale verdict from a venue we stopped
 * supporting. The projection was correct; the SET it projected was the wrong one.
 *
 * The fix is a SCOPE fix, not a docs filter. Filtering the docs while the API still accepted 17
 * would have forced `check-docs-samples-live` P7 down from set-equality to a subset check —
 * weakening a gate shipped two waves ago to hide a scope problem. Narrowing what the API ACCEPTS
 * makes docs and schema agree at 15 with no filter and no weakened gate.
 *
 * 🛑 DERIVED, never subtracted. `PROMOTED_VENUE_IDS` ← `EXCHANGES` is the promotion registry, so a
 * venue joins the public API, the docs tables and the x402 bazaar listing from ONE registry edit,
 * and leaves the same way. Writing this as `VENUE_IDS_ALL` minus a hardcoded `['EDGEX','WEEX']`
 * would look equivalent and re-publish venue 18 the day it is wired — the same defect one layer
 * down, which is precisely how the first version of this bug was written.
 */
export const PUBLIC_VENUE_IDS = PROMOTED_VENUE_IDS;

/**
 * The same set, shaped for `z.enum`, which requires a non-empty TUPLE while `PROMOTED_VENUE_IDS`
 * is a readonly array. The cast lives HERE, once, so the three call sites in `src/index.ts` stay
 * identical to each other — a per-site cast is four places to get the element type wrong, and
 * widening it to `[string, ...string[]]` (the cast that compiles first) silently erases the
 * literal union, so every handler's `exchange` degrades to `string` and stops type-checking
 * against `ExchangeId`. `src/tools/scan-trade-calls.ts:87` uses the same idiom.
 */
export const PUBLIC_VENUE_ENUM = PUBLIC_VENUE_IDS as [PromotedVenueId, ...PromotedVenueId[]];

/** `get_market_regime` classifies on the slower candles only — a deliberate subset of TIMEFRAMES. */
export const REGIME_TIMEFRAMES = ['1h', '4h', '1d'] as const;

/** `assetClass` forces the engine instead of letting the shared router choose from the symbol. */
export const ASSET_CLASSES = ['perp', 'equity'] as const;

/** `scan_trade_calls` OI-delta lens knobs. */
export const OI_CHANGE_WINDOWS = ['1h', '4h', '24h'] as const;
export const OI_BASES = ['notional', 'contracts'] as const;

/**
 * Schema defaults, consumed by BOTH the Zod site and the docs projection.
 *
 * A default is as publishable a fact as the enum beside it, and it rotted the same way: the page
 * said `scan_trade_calls` defaulted to `1h` when the server had been defaulting to `15m`. Naming
 * each one once is what stops a "Default:" chip and a `.default()` call from disagreeing.
 *
 * `get_trade_call` has NO Zod default on `timeframe`/`exchange` and must not gain one —
 * TRADE-CALL-ROUTING-RESOLVER-W1 needs "the caller named a venue/TF" to stay distinguishable from
 * "bare" so the shared resolver can route to the perp or equity engine. Its effective fallbacks
 * are applied downstream by `resolveMarketRoute`, so they are resolver behaviour rather than a
 * schema fact, and the docs row states them in authored prose instead of projecting them.
 */
export const REGIME_TIMEFRAME_DEFAULT = '4h' as const;
export const REGIME_EXCHANGE_DEFAULT = 'HL' as const;
export const SCAN_TIMEFRAME_DEFAULT = '15m' as const;
export const SCAN_EXCHANGE_DEFAULT = 'BINANCE' as const;
export const SCAN_OI_CHANGE_WINDOW_DEFAULT = '24h' as const;
export const SCAN_OI_BASIS_DEFAULT = 'notional' as const;

/** One projected parameter: the accepted values, and the default the schema declares (if any). */
export interface EnumParamSpec {
  values: readonly string[];
  default?: string;
}

/**
 * Every enum-valued parameter of every PUBLICLY DOCUMENTED tool, keyed by the tool name
 * `tools/list` publishes.
 *
 * `scripts/build_docs.mjs` renders one table row per entry, generically — it branches on nothing.
 * A new enum parameter joins `/docs` by appearing here, with no docs edit at all. Non-enum
 * parameters (`coin`, `topN`, `rankBy`, `minLiquidityUsd`, …) stay hand-authored in
 * `docs-src/partials/`, because their prose is written for humans rather than for a model; the
 * live gate asserts separately that none of them can go MISSING.
 *
 * NOTE — `rankBy` is deliberately absent, and that is measured rather than forgotten: it is a
 * bounded `z.string().max(32)`, not an enum, so the bot can forward an alias (`nfr`/`pfr`/…)
 * verbatim with `resolveRankBy` owning which tokens are actually valid. Its docs row points at
 * `/capabilities` for the live lens set, which is the honest rendering of a non-enum parameter.
 */
export const PUBLIC_TOOL_ENUM_PARAMS: Readonly<Record<string, Readonly<Record<string, EnumParamSpec>>>> =
  Object.freeze({
    get_trade_call: Object.freeze({
      timeframe: Object.freeze({ values: TIMEFRAMES }),
      exchange: Object.freeze({ values: PUBLIC_VENUE_IDS }),
      assetClass: Object.freeze({ values: ASSET_CLASSES }),
    }),
    get_market_regime: Object.freeze({
      timeframe: Object.freeze({ values: REGIME_TIMEFRAMES, default: REGIME_TIMEFRAME_DEFAULT }),
      exchange: Object.freeze({ values: PUBLIC_VENUE_IDS, default: REGIME_EXCHANGE_DEFAULT }),
    }),
    scan_trade_calls: Object.freeze({
      timeframe: Object.freeze({ values: TIMEFRAMES, default: SCAN_TIMEFRAME_DEFAULT }),
      // All three tools now resolve to the SAME 15: scan was always the promoted universe, and
      // the other two narrowed to it. The sets are equal by DERIVATION, not by coincidence.
      exchange: Object.freeze({ values: PROMOTED_VENUE_IDS, default: SCAN_EXCHANGE_DEFAULT }),
      oiChangeWindow: Object.freeze({ values: OI_CHANGE_WINDOWS, default: SCAN_OI_CHANGE_WINDOW_DEFAULT }),
      oiBasis: Object.freeze({ values: OI_BASES, default: SCAN_OI_BASIS_DEFAULT }),
    }),
  });

/**
 * The docs `partial id` each tool's projected rows are rendered into — the ONE mapping between a
 * `tools/list` name and a `docs-src/partials/<id>.html` file.
 *
 * Both `build_docs.mjs` (which fills the region) and `check-docs-samples-live.mjs` (which asserts
 * the rendered result against production) read this, so a renamed partial cannot leave the gate
 * silently probing a region that no longer exists.
 */
export const TOOL_DOCS_PARTIAL: Readonly<Record<string, string>> = Object.freeze({
  get_trade_call: 'get-trade-call',
  get_market_regime: 'get-market-regime',
  scan_trade_calls: 'scan-trade-calls',
});

/**
 * Human-facing sentence for each projected row, so the generated table reads like the
 * hand-written rows beside it rather than like a schema dump.
 *
 * Deliberately separate from the Zod `.describe()` strings: those are tuned for a model choosing
 * a tool and carry retrieval phrasing that reads as noise on a page a person is reading. Only the
 * sentence is authored — every VALUE in the row is projected.
 */
export const PARAM_DOC_BLURB: Readonly<Record<string, string>> = Object.freeze({
  timeframe: 'Candle interval.',
  exchange: 'Venue to query. Asset availability varies per venue — pass one explicitly to target it.',
  assetClass: 'Force the engine instead of letting the router infer it from the symbol.',
  oiChangeWindow: 'Open-interest delta window for the oi_change lens. Ignored by other lenses.',
  oiBasis: 'Whether the open-interest delta is measured in notional value or in contract count.',
});
