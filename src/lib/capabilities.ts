/**
 * AUTO-TRACE-W1 (2026-04-30) — Canonical Single-Source-of-Truth for capability
 * counters: exchange list, timeframe list, asset count.
 *
 * Every public surface (track-record dashboard subtitle, signup pricing-card
 * bullets, landing meta tags, README, manifest.json, llms.txt, JSON-LD
 * schema.org `description`) MUST resolve its capability counters from this
 * module — directly (server-rendered) or via `/api/performance-public` proxy
 * (client-rendered). Hardcoded literals like `5 exchanges` or `290+ assets`
 * are forbidden outside a `data-tr-field=` proxy span or a `<!-- SNAPSHOT:
 * * -->` build-time marker block (CI canary in `tests/unit/copy-consistency.
 * test.ts` enforces this).
 *
 * Onboarding the 6th exchange:
 *   1. Implement the new adapter under `src/lib/adapters/<name>.ts`.
 *   2. Add the case to `src/lib/exchange-adapter.ts:getAdapter()` switch.
 *   3. Append the `ExchangeId` literal in `src/types.ts:95`.
 *   4. Append the entry to the `EXCHANGES` array below.
 *   5. Run `npm run snapshot:capabilities` (refreshes static surfaces:
 *      README.md, manifest.json, server.json, llms*.txt, landing/index.html
 *      meta + JSON-LD).
 *   6. `git push` — track-record + signup + pricing cards auto-update via
 *      proxy on next page render (no rebuild needed for client-side surfaces).
 *
 * No literal `5 exchanges` / `<N>+ assets` / `<N> timeframes` is allowed
 * elsewhere; this is the canonical export.
 */

import type { ExchangeId } from '../types.js';

/**
 * Exchange registry — preserves rendering order for prose lists ("Hyperliquid,
 * Binance, Bybit, OKX, Bitget"). Display label is what end users see; `id` is
 * the canonical `ExchangeId` used by adapters and the cross-asset grid.
 */
export interface ExchangeEntry {
  id: ExchangeId;
  /** End-user-facing display name (proper-case, no abbreviation). */
  label: string;
}

export const EXCHANGES = Object.freeze([
  { id: 'HL',      label: 'Hyperliquid' },
  { id: 'BINANCE', label: 'Binance' },
  { id: 'BYBIT',   label: 'Bybit' },
  { id: 'OKX',     label: 'OKX' },
  { id: 'BITGET',  label: 'Bitget' },
  // OPS-VENUE-GO-LIVE-2026-06-30 (EXCHANGE-EXPANSION-CADENCE): promoted set 5→12.
  // The 7 below cleared the promotion gate clean (✅ QUALIFIED, no --force); BITMART
  // held (sample below bar). Appended alphabetically after the original 5 — this
  // array also fixes prose rendering order. EXCHANGE_COUNT (below) → 12 from here,
  // the single source every count surface reads (eyebrow / track-record header /
  // Tier-2 FAQ / /api/performance-public.exchange_count).
  { id: 'ASTER',   label: 'Aster' },
  { id: 'BINGX',   label: 'BingX' },
  { id: 'GATE',    label: 'Gate.io' },
  { id: 'HTX',     label: 'HTX' },
  { id: 'KUCOIN',  label: 'KuCoin' },
  { id: 'MEXC',    label: 'MEXC' },
  { id: 'PHEMEX',  label: 'Phemex' },
  // OPS-VENUE-GO-LIVE-15-W1 (2026-07-23): promoted set 12→15. All three cleared C1's force floor
  // (WR≥0.70 ∧ day≥7 ∧ pfe_wr≠null): BITMART (WR 93.9%, sample 108%) + WHITEBIT (89.9%, 144%)
  // promoted clean; XT (91.8%, sample 96% — 392 short) with pre-authorised --force. Vendor-cased
  // labels verified vs each venue's own site (WhiteBIT / BitMart / XT). EXCHANGE_COUNT → 15 here.
  { id: 'WHITEBIT', label: 'WhiteBIT' },
  { id: 'XT',       label: 'XT' },
  // OPS-WEEX-PROMOTE-W1 (2026-09-04): promoted set 14→15. OPERATOR OVERRIDE, dated, and the
  // reason is recorded here because someone will ask why WEEX was promoted at 11% of its
  // live-rule bar. The `verdict_rule_version = 2` sample condition that OPS-WEEX-PROMOTION-
  // READINESS-W1 set was WITHDRAWN by Mr.1: the TREND_MODE flip of 2026-08-31 was FLEET-WIDE,
  // so all 14 incumbents publish a WR blended across it, and holding WEEX alone to a pure-v2
  // bar would apply a standard NO INCUMBENT MEETS.
  //   - published (blended)  93.43% over 5194 rows  <- what byExchange serves
  //   - live rule (v2 slice)  87.72% over  782 rows (q 93.86%)
  //   - bar in force at flip: 7230 (asset_count 723 x 10); 10230 after the asset_count refresh
  // Promoted with --force; it clears the codified force floor on every axis (pfe_wr non-null,
  // >=0.70, days_since >= 7) — the floor is not what held it. Vendor casing "WEEX" verified
  // against weex.com. EXCHANGE_COUNT -> 15 here.
  { id: 'WEEX',     label: 'WEEX' },
] as const) satisfies readonly ExchangeEntry[];

export const EXCHANGE_COUNT: number = EXCHANGES.length;

/**
 * OPS-SCAN-UNIVERSE-EXPAND-W1 — the promoted-venue id union, DERIVED from `EXCHANGES`
 * (the single SoT). `EXCHANGES` is `as const`, so this resolves to the exact literal
 * union, NOT the full `ExchangeId`. The scan-shape representations (the universe FETCHERS record,
 * `ScanExchangeId`, `SCAN_EXCHANGES`, the Zod tool enum, the x402 bazaar enum) project from this —
 * so a `Record<PromotedVenueId, …>` is tsc-exhaustive and "forgot to add the new venue to scan"
 * becomes a compile error.
 *
 * OPS-BITMART-ENUM-RECONCILE-W1 — RECONCILED. This static union and the live `venues` table now
 * AGREE: BitMart was retired 2026-08-27 and is removed from `EXCHANGES` here, so `EXCHANGE_COUNT`
 * states 14 and `byExchange` serves 14. Before this wave the two disagreed for 7 days (15 published
 * vs 14 served) and nothing caught it.
 *
 * This wave SUBSUMED `OPS-BITMART-ENUM-REMOVE-W1` (architect ruling 2026-09-02) — that wave name is
 * retired; there is ONE owner for this reconciliation, not a silent overlap.
 *
 * DO NOT restore the claim this block once made — that a unit test asserted this set equals
 * `listVenues('promoted')`. It NEVER EXISTED, and it could not live in the unit suite anyway: that
 * suite runs on SQLite with no production Postgres, so a parity test written there ships DARK, which
 * is precisely the defect class it would exist to catch. Drift is now caught by the ops-scheduled
 * PG-lane gate `promoted-set-drift-canary` (three-way identity: this static list == live
 * `exchange_count` == live `byExchange` keys == `SELECT exchange_id FROM venues WHERE
 * status='promoted'`, by symmetric difference).
 *
 * Registries that DRIVE LIVE API CALLS still do NOT iterate this directly — they iterate
 * `getActivePromotedVenueIds()` (venue-store.ts) = this list MINUS retired — because a venue is
 * retired in the DB before its enum removal lands, and that window must degrade safely.
 */
export type PromotedVenueId = (typeof EXCHANGES)[number]['id'];

/** Runtime projection of {@link PromotedVenueId} — the promoted ids in render order. */
export const PROMOTED_VENUE_IDS: readonly PromotedVenueId[] = EXCHANGES.map((e) => e.id);

/**
 * Timeframes accepted by `get_trade_call`'s Zod enum. SOURCE OF TRUTH must
 * match the enum at `src/index.ts:97`. Unit test
 * `tests/unit/capabilities.test.ts` asserts the two arrays are identical.
 *
 * Note: only 9 of these (5m–1d) are cron-seeded for the public track-record
 * dashboard; 1m/3m are available via API on-demand but don't accrue rolling-
 * window PFE data. The COUNT field exposed via /api/performance-public is the
 * full 11 (API capability), not the 9 cron-seeded subset — see brand-facts.md
 * §Asset coverage for the disambiguation.
 */
export const TIMEFRAMES: readonly string[] = Object.freeze([
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d',
]);

export const TIMEFRAME_COUNT: number = TIMEFRAMES.length;

/**
 * Live distinct-asset count. Sourced from the same `byAsset` aggregation that
 * powers the track-record dashboard, NOT from a fresh DB query. Returns 0 if
 * the performance store is empty (e.g. fresh deploy before first cron seed),
 * in which case the static fallback in the rendered HTML stays visible.
 *
 * 5-min in-process TTL cache — these change on the order of weeks (new asset
 * added on an exchange ≈ once per few weeks); 5 min keeps the cost of the
 * call near zero without making the value stale enough to drift visibly.
 */
let _assetCountCache: { value: number; fetchedAt: number } | null = null;
const ASSET_COUNT_TTL_MS = 5 * 60 * 1000;

export async function getAssetCount(): Promise<number> {
  if (_assetCountCache && Date.now() - _assetCountCache.fetchedAt < ASSET_COUNT_TTL_MS) {
    return _assetCountCache.value;
  }
  // Lazy import to avoid a top-level circular dep (performance-db imports
  // asset-tiers which is a sibling of this file, not capabilities — safe — but
  // keep the dynamic-import shape consistent with the cache pattern.)
  try {
    const { getSignalPerformance } = await import('../resources/signal-performance.js');
    const stats = await getSignalPerformance();
    const count = stats?.byAsset ? Object.keys(stats.byAsset).length : 0;
    _assetCountCache = { value: count, fetchedAt: Date.now() };
    return count;
  } catch {
    // Test/dev contexts where performance-db is mocked or DB is unavailable.
    return 0;
  }
}

/**
 * Floor-rounds an integer DOWN to the nearest 10 for marketing display
 * ("718" → "710+"). Used by snapshot script + client-side proxy formatter.
 * Round-floor (not round-nearest) so we never overstate the count — if live
 * data drops a coin the displayed number stays under the live total.
 */
export function floorRoundTo10(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n / 10) * 10;
}

/**
 * Test-only — clears the in-process cache so unit tests can re-run with a
 * fresh state.
 */
export function _resetCapabilitiesCache(): void {
  _assetCountCache = null;
}
