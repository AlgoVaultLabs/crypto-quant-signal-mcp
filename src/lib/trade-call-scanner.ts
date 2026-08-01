// ── Cross-asset trade-call scanner (SCAN-TRADE-CALLS-W1 C2) ──
//
// Compute engine behind the public `scan_trade_calls` MCP/HTTP tool. Returns
// ranked composite-verdict trade calls across the top 1–100 perps by notional
// open interest on a chosen PROMOTED venue (HL/BINANCE/BYBIT/OKX/BITGET).
//
// Mirrors the proven `cross-asset-grid.ts` fan-out shape — TTL snapshot,
// promise-coalesced refresh, `pLimit` bounded concurrency, per-cell isolation
// — but parameterised by (exchange, timeframe, topN) instead of a fixed grid.
//
// Design notes:
//   • Universe via `getExchangeTopAssetsWithVolume` (the 5 PROMOTED venues
//     only — it throws on shadow venues; callers filter via the tool enum).
//     NOT oi-ranking.ts (HL-only, different purpose).
//   • Each cell scores via `getTradeSignal({ internal: true })` so scan cells
//     NEVER touch the per-coin quota counter or the performance-db track record
//     (preserves the on-chain ↔ dashboard equality canary). The tool HANDLER
//     charges the batch via the C1 multi-unit quota seam (the `units` param) —
//     quota is the handler's job, never this module's.
//   • Coalescing is PER-COIN: concurrent scans for the same (exchange,timeframe)
//     share one in-flight score per coin, so 2 identical concurrent scans score
//     each coin once, not twice. Smaller topN is served by snapshot slice;
//     larger topN tops up only the missing coins.
//   • Allow-list result shaping (CLAUDE.md public-API LAW): `toScanCallItem`
//     is the EXPORTED pure formatter; `ScanCallItem` carries ONLY
//     {coin, timeframe, exchange, call, confidence, regime} — no price, no
//     indicators, no reasoning, and never any `outcome_*` field.
//   • No track-record persistence, no quota increment, no Telegram here — the
//     module is read-only over the scoring path; side effects are the handler's.
//
// Frozen exports for C3/C4: scanTradeCalls, getTopCoinSet, ScanTradeCallsResult,
// ScanCallItem, _setScanScorerForTest, _clearScanCaches.

import pLimit from 'p-limit';
import { getTradeSignal } from '../tools/get-trade-call.js';
import { getExchangeTopAssetsWithVolume, fetchVenueUniverse, effectiveLiquidityUsd } from './exchange-universe.js';
import { PROMOTED_VENUE_IDS, type PromotedVenueId } from './capabilities.js';
import { getRankedUniverse, type RankedAsset } from './rank-metrics.js';
import { resolveRankBy, type RankBy } from './rank-constants.js';
import type { OiWindow, OiBasis } from './oi-snapshots.js';
import { ResultCache } from './result-cache.js';
import type { SignalVerdict, RegimeType, TradeCallResult } from '../types.js';
import { enrichScanCall } from './scan-digest.js';
import type { ReceiptFactor } from './receipts.js';

// OPS-SCAN-UNIVERSE-EXPAND-W1: the promoted-venue scan set, DERIVED from EXCHANGES (capabilities.ts —
// the single SoT). Was a hand-maintained 5-literal; now `ScanExchangeId` is the 12-promoted union and
// `SCAN_EXCHANGES` its runtime projection, so a new promoted venue flows into the scan automatically
// (getExchangeTopAssetsWithVolume now covers all 12 + fail-softs on the rest).
export type ScanExchangeId = PromotedVenueId;
export const SCAN_EXCHANGES: readonly ScanExchangeId[] = PROMOTED_VENUE_IDS;

/** Public per-coin scan row — allow-listed projection of a trade call. */
export interface ScanCallItem {
  coin: string;
  timeframe: string;
  exchange: ScanExchangeId;
  call: SignalVerdict;
  confidence: number;
  regime: RegimeType;
  // ── SCAN-RANKBY-W1: additive rank-metric echo. Present ONLY for a non-default
  //    (non-`oi`) lens; omitted/`oi` ⇒ byte-identical to the historical shape.
  //    NEVER any `outcome_*`. ──
  /** The metric this call's universe was ranked by (OI USD / volume USD / 24h % / funding). */
  rank_value?: number;
  /** gainers / losers / movers. */
  change_24h_pct?: number;
  /** volume. */
  volume_24h?: number;
  /** funding_positive / funding_negative — per-interval funding fraction. */
  funding_rate?: number;
  /** funding_* — annualized APR, or null when the interval is unknown. */
  funding_apr?: number | null;
  /** volatility — ATRP (ATR(14) ÷ price × 100) on the scan timeframe. */
  atrp?: number;
  /** oi_change — REAL OI % delta over the window (computeOiDelta over oi_snapshots). */
  oi_change_pct?: number;
  /** oi_change — the OI-delta window label, e.g. "24h". */
  oi_change_window?: string;
  /** oi_change — CH3: the OI-delta basis, present ONLY for the non-default 'contracts'. */
  oi_change_basis?: OiBasis;
  // ── SCAN-DIGEST-MCP-PARITY-W1 CH1: enriched-mode fields. Present ONLY when the
  //    caller passes includeReasoning:true (for a non-HOLD call); omitted in bare
  //    mode ⇒ byte-identical to the historical shape. Projected by enrichScanCall
  //    (allow-list); NEVER raw `indicators` / `outcome_*`. ──
  /** Live price at scan time. */
  price?: number;
  /** Top 2–3 salient drivers — the SAME mapping get_trade_call emits (formatReceipts). */
  factors?: ReceiptFactor[];
  /** Engine reasoning (deterministic bucket-prose). */
  reasoning?: string;
}

export interface ScanTradeCallsResult {
  /** Universe size attempted (top-N coins by OI on the venue). */
  scanned: number;
  /** Non-HOLD calls in the RETURNED `calls[]` — the handler's quota-unit driver. */
  eligible_non_hold: number;
  /** HOLD cells computed (informational; HOLDs are free + excluded unless includeHolds). */
  holds: number;
  /** Cells that failed to score (isolated + skipped). */
  errors: number;
  /** True when the deadline elapsed before every cell completed. */
  partial: boolean;
  calls: ScanCallItem[];
}

export interface ScanTradeCallsParams {
  topN?: number;
  timeframe?: string;
  exchange?: ScanExchangeId;
  minConfidence?: number;
  includeHolds?: boolean;
  limit?: number;
  /** SCAN-RANKBY-W1: raw universe-selection lens token (canonical or alias). The
   *  scanner resolves it via `resolveRankBy` (unknown → 'oi'); the handler does the
   *  strict reject. Omitted ⇒ 'oi' (byte-identical default). */
  rankBy?: string;
  /** SCAN-DIGEST-MCP-PARITY-W1 CH1: enrich each non-HOLD call at OUTPUT with
   *  price + factors + reasoning (+ oi_change_window) via enrichScanCall. Default
   *  false ⇒ bare verdict cells, byte-identical to today. Orthogonal to rankBy. */
  includeReasoning?: boolean;
  /** FIX-CONVICTION-CALL-POSTS-W1: minimum USD liquidity (notional OI, or 24h volume on
   *  proxy venues — see `effectiveLiquidityUsd`) an asset must clear to enter the scan
   *  universe. Omitted or 0 ⇒ no floor ⇒ byte-identical to before this param existed.
   *  Composes with every `rankBy`. */
  minLiquidityUsd?: number;
  /** SCAN-RANKBY-REFINEMENTS-W1 CH1: OI-delta window for the oi_change lens
   *  (1h/4h/24h). Omitted ⇒ '24h' (byte-identical). Ignored by other lenses. */
  oiChangeWindow?: OiWindow;
  /** SCAN-RANKBY-REFINEMENTS-W1 CH3: OI-delta basis for the oi_change lens
   *  (notional/contracts). Omitted ⇒ 'notional' (byte-identical). Ignored by other lenses. */
  oiBasis?: OiBasis;
}

/** The subset a scorer yields. Decouples the scanner from the full TradeCallResult,
 *  but RETAINS (Option A) the canonical per-coin detail the live scorer always
 *  computes — so the enriched projection needs no recompute. */
export interface ScanScore {
  coin: string;
  timeframe: string;
  call: SignalVerdict;
  confidence: number;
  regime: RegimeType;
  // ── SCAN-DIGEST-MCP-PARITY-W1 CH1 (Option A, architect-ratified): canonical detail.
  //    Optional so a bare/test scorer may omit it (those exercise bare mode). ──
  /** Live price. */
  price?: number;
  /** Engine indicators — drives the digest factors + the oi_change_window label. */
  indicators?: TradeCallResult['indicators'];
  /** Engine reasoning (deterministic bucket-prose; no LLM). */
  reasoning?: string;
}

type ScanScorer = (coin: string, timeframe: string, exchange: ScanExchangeId) => Promise<ScanScore>;

/**
 * EXPORTED pure formatter (allow-list LAW). Projects a score onto the public
 * `ScanCallItem` shape — explicit field copy, never a spread, so a wider score
 * object can never leak `price` / `indicators` / `reasoning` / `outcome_*`.
 */
export function toScanCallItem(score: ScanScore, exchange: ScanExchangeId): ScanCallItem {
  return {
    coin: score.coin,
    timeframe: score.timeframe,
    exchange,
    call: score.call,
    confidence: score.confidence,
    regime: score.regime,
  };
}

/**
 * SCAN-RANKBY-W1: attach the rank-metric echo to an output call (allow-list LAW —
 * explicit copy, never spread). Applied at OUTPUT assembly, NOT baked into the
 * cached verdict cell (a coin's verdict is rank-independent — caching the rank
 * fields would cross-contaminate a later scan under a different lens). `ranked`
 * absent (or the default `oi` lens) ⇒ the verdict-only shape, byte-identical.
 * Only the typed field(s) for THIS lens are emitted; never any `outcome_*`.
 */
export function attachRank(item: ScanCallItem, ranked: RankedAsset | undefined): ScanCallItem {
  // `item` is ALREADY an allow-listed projection (toScanCallItem / enrichScanCall),
  // so a shallow copy is leak-safe — no raw engine field ever reached it. The copy
  // PRESERVES any enrichment fields (enriched mode) while adding the lens-VARYING
  // rank echo at OUTPUT only (never the cached cell — W1 law).
  const out: ScanCallItem = { ...item };
  if (!ranked || ranked.rankBy === 'oi') return out;
  out.rank_value = ranked.rank_value;
  if (ranked.change_24h_pct !== undefined) out.change_24h_pct = ranked.change_24h_pct;
  if (ranked.volume_24h !== undefined) out.volume_24h = ranked.volume_24h;
  if (ranked.funding_rate !== undefined) out.funding_rate = ranked.funding_rate;
  if (ranked.funding_apr !== undefined) out.funding_apr = ranked.funding_apr;
  if (ranked.atrp !== undefined) out.atrp = ranked.atrp;
  if (ranked.oi_change_pct !== undefined) out.oi_change_pct = ranked.oi_change_pct;
  if (ranked.oi_change_window !== undefined) out.oi_change_window = ranked.oi_change_window;
  if (ranked.oi_change_basis !== undefined) out.oi_change_basis = ranked.oi_change_basis;
  return out;
}

/** Real scorer — the internal trade-call compute path (skips quota + track record). */
async function defaultScorer(coin: string, timeframe: string, exchange: ScanExchangeId): Promise<ScanScore> {
  // Option A (architect-ratified 2026-06-28): ALWAYS compute the canonical detail
  // (includeReasoning:true) — reasoning is cheap deterministic bucket-prose (no LLM)
  // and the cell caches it, so the enriched projection NEVER recomputes. Bare callers
  // simply project it away via toScanCallItem.
  const r = await getTradeSignal({ coin, timeframe, exchange, includeReasoning: true, internal: true });
  return {
    coin: r.coin,
    timeframe: r.timeframe,
    call: r.call,
    confidence: r.confidence,
    regime: r.regime,
    price: r.price,
    indicators: r.indicators,
    reasoning: r.reasoning,
  };
}

// ── Env config (default-deny parse per CLAUDE.md — non-finite / <1 → default) ──
function envPositiveInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : def;
}

// ── Module-private state ──
interface CachedCell {
  // CH1 (Option A): cache the canonical SCORE (the rank-independent per-coin detail),
  // NOT a projected item — bare/enriched both project from it at OUTPUT. The lens-
  // varying rank echo is never cached (attachRank at output only — W1 law).
  score: ScanScore;
  at: number;
}
/** `${exchange}:${timeframe}` → (coin → cell). Stores cells for the largest topN computed. */
const snapshots = new Map<string, Map<string, CachedCell>>();
/** `${exchange}:${timeframe}:${coin}` → in-flight score, for per-coin coalescing. */
const inflightCells = new Map<string, Promise<ScanScore>>();
/** Last-known-good universe per `${exchange}:${n}` — served when a fresh fetch throws. */
const lastKnownGoodUniverse = new Map<string, string[]>();
let universeCache: ResultCache<string[]> | null = null;
let _scorerOverride: ScanScorer | null = null;

function getUniverseCache(): ResultCache<string[]> {
  if (!universeCache) {
    universeCache = new ResultCache<string[]>({
      ttlMs: envPositiveInt('SCAN_UNIVERSE_TTL_SEC', 600) * 1000,
      max: 256,
    });
  }
  return universeCache;
}

/**
 * Resolve the top-`n` coin set on a promoted venue, OI-desc-sorted. Fresh
 * results are cached in a `ResultCache` keyed `${exchange}:${n}`. Stale-on-
 * error: if a fetch throws but we have a last-known-good set, serve it; with no
 * prior good set, the error propagates.
 */
// ── FIX-CONVICTION-CALL-POSTS-W1: venue liquidity map for the optional universe floor ──
// 60s TTL, matching `scan_funding_arb`'s per-leg gate cache. Only consulted when a caller
// actually passes `minLiquidityUsd`, so the default scan path performs no extra fetch.
const LIQUIDITY_TTL_MS = 60_000;
const liquidityCache = new Map<string, { at: number; byCoin: Map<string, number> }>();

/** Test seam, matching `_setScorerForTest` et al.: when set, the floor reads this instead
 *  of the live universe, so unit tests never touch the network. */
let _liquidityMapOverride: ((exchange: ScanExchangeId) => Map<string, number>) | null = null;
export function _setLiquidityMapForTest(fn: ((exchange: ScanExchangeId) => Map<string, number>) | null): void {
  _liquidityMapOverride = fn;
  liquidityCache.clear();
}

/** coin → USD liquidity on `exchange`. Fail-soft to an EMPTY map, which makes the floor
 *  default-DENY rather than silently admitting an ungated universe. */
async function getVenueLiquidityUsd(exchange: ScanExchangeId): Promise<Map<string, number>> {
  if (_liquidityMapOverride) return _liquidityMapOverride(exchange);
  const now = Date.now();
  const hit = liquidityCache.get(exchange);
  if (hit && now - hit.at <= LIQUIDITY_TTL_MS) return hit.byCoin;
  const byCoin = new Map<string, number>();
  try {
    // Full universe, not the top-N slice: the floor must be able to judge any coin the
    // lens selected, including one outside the OI head.
    for (const a of await fetchVenueUniverse(exchange)) byCoin.set(a.coin, effectiveLiquidityUsd(a));
  } catch (err) {
    console.debug(
      `[trade-call-scanner] liquidity universe fetch failed for ${exchange} — floor will deny all:`,
      err instanceof Error ? err.message : err,
    );
  }
  liquidityCache.set(exchange, { at: now, byCoin });
  return byCoin;
}

export async function getTopCoinSet(exchange: ScanExchangeId, n: number): Promise<string[]> {
  const cache = getUniverseCache();
  const key = `${exchange}:${n}`;
  const fresh = cache.get(key);
  if (fresh) return fresh;
  try {
    const assets = await getExchangeTopAssetsWithVolume(exchange, n);
    const coins = assets.map((a) => a.coin);
    cache.set(key, coins);
    lastKnownGoodUniverse.set(key, coins);
    return coins;
  } catch (err) {
    const stale = lastKnownGoodUniverse.get(key);
    if (stale) {
      console.debug(
        `[trade-call-scanner] universe fetch failed for ${key}; serving stale (${stale.length} coins):`,
        err instanceof Error ? err.message : err,
      );
      return stale;
    }
    throw err;
  }
}

/**
 * Return a coin's cell from the (exchange,timeframe) snapshot when fresh,
 * otherwise compute it. Per-coin promise coalescing ensures concurrent callers
 * share a single in-flight score. Throws on scorer failure (caller isolates).
 */
async function getOrComputeCell(
  exchange: ScanExchangeId,
  timeframe: string,
  coin: string,
  scorer: ScanScorer,
  snapshotTtlMs: number,
): Promise<ScanScore> {
  const skey = `${exchange}:${timeframe}`;
  let snap = snapshots.get(skey);
  if (!snap) {
    snap = new Map<string, CachedCell>();
    snapshots.set(skey, snap);
  }
  const cached = snap.get(coin);
  if (cached && Date.now() - cached.at <= snapshotTtlMs) return cached.score;

  const ckey = `${skey}:${coin}`;
  const inflight = inflightCells.get(ckey);
  if (inflight) return inflight;

  const p = (async () => {
    const score = await scorer(coin, timeframe, exchange);
    snap!.set(coin, { score, at: Date.now() });
    return score;
  })();
  inflightCells.set(ckey, p);
  try {
    return await p;
  } finally {
    if (inflightCells.get(ckey) === p) inflightCells.delete(ckey);
  }
}

/** Resolve `work`, or report `true` if `ms` elapses first (work keeps running). */
async function raceDeadline(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), ms);
  });
  const done = work.then(() => false);
  const timedOut = await Promise.race([done, timeout]);
  if (timer) clearTimeout(timer);
  return timedOut;
}

function clampInt(n: number, lo: number, hi: number, def: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : def;
}

/**
 * Scan the top-`topN` perps on `exchange` at `timeframe`, returning ranked
 * non-HOLD trade calls (then HOLDs when `includeHolds`), clamped to `limit`.
 * `minConfidence` filters non-HOLD only. Never charges quota or records signals.
 */
export async function scanTradeCalls(params: ScanTradeCallsParams): Promise<ScanTradeCallsResult> {
  const topN = clampInt(params.topN ?? 20, 1, 100, 20);
  const timeframe = params.timeframe ?? '15m';
  const exchange = params.exchange ?? 'BINANCE';
  const minConfidence = params.minConfidence;
  const includeHolds = params.includeHolds ?? false;
  const limit = clampInt(params.limit ?? 10, 1, 100, 10);
  const includeReasoning = params.includeReasoning ?? false;

  const concurrency = envPositiveInt('SCAN_CONCURRENCY', 6);
  const snapshotTtlMs = envPositiveInt('SCAN_SNAPSHOT_TTL_SEC', 60) * 1000;
  const deadlineMs = envPositiveInt('SCAN_DEADLINE_MS', 30000);
  const scorer = _scorerOverride ?? defaultScorer;

  // SCAN-RANKBY-W1: universe selection by lens. `oi` (default) stays on the existing
  // path — byte-identical output + webhook/test parity. Other lenses use the
  // generalized metric selector and carry a per-coin rank echo (attached at OUTPUT,
  // never cached into the rank-independent verdict cell).
  const rankBy: RankBy = resolveRankBy(params.rankBy) ?? 'oi';
  let coins: string[];
  let rankMap: Map<string, RankedAsset> | undefined;
  if (rankBy === 'oi') {
    coins = await getTopCoinSet(exchange, topN);
  } else {
    // SCAN-RANKBY-W2: pass timeframe (volatility/ATRP ranks on the scan timeframe).
    // SCAN-RANKBY-REFINEMENTS-W1 CH1: forward the OI-delta window for the oi_change lens.
    const ranked = await getRankedUniverse(exchange, rankBy, topN, timeframe, {
      oiChangeWindow: params.oiChangeWindow,
      oiBasis: params.oiBasis,
    });
    coins = ranked.map((r) => r.coin);
    rankMap = new Map(ranked.map((r) => [r.coin, r]));
  }

  // FIX-CONVICTION-CALL-POSTS-W1: optional USD liquidity floor on the UNIVERSE.
  //
  // Why the universe and not the output: the per-call payload carries no liquidity
  // field at all (coin/call/confidence/regime/factors/reasoning/price — verified
  // against the live tool), so a CONSUMER cannot filter for itself. Gating here is the
  // only place the data exists, and it makes the floor one shared derivation that every
  // surface inherits by passing one param instead of each re-implementing it.
  //
  // Applied AFTER lens selection so it composes with every `rankBy` uniformly. Omitted
  // or 0 ⇒ the block is skipped ⇒ byte-identical to before the param existed.
  //
  // Fail-soft is default-DENY on purpose: an unreachable universe yields an empty map,
  // every coin scores 0 and nothing clears the floor — matching `scan_funding_arb`'s
  // long-standing per-leg gate, rather than silently scanning an UNGATED universe,
  // which is the failure mode that would actually reach print.
  const minLiquidityUsd = params.minLiquidityUsd;
  if (minLiquidityUsd != null && minLiquidityUsd > 0 && coins.length > 0) {
    const liquidity = await getVenueLiquidityUsd(exchange);
    const before = coins.length;
    coins = coins.filter((c) => (liquidity.get(c) ?? 0) >= minLiquidityUsd);
    if (rankMap) {
      const rm = rankMap;
      rankMap = new Map(coins.flatMap((c) => (rm.get(c) ? [[c, rm.get(c)!] as [string, RankedAsset]] : [])));
    }
    console.debug(
      `[trade-call-scanner] liquidity floor $${minLiquidityUsd.toLocaleString()} on ${exchange}: ${coins.length}/${before} coins cleared`,
    );
  }

  const scanned = coins.length;

  const limiter = pLimit(concurrency);
  const cells: (ScanScore | null)[] = new Array(coins.length).fill(null);
  let errors = 0;
  const tasks = coins.map((coin, i) =>
    limiter(async () => {
      try {
        cells[i] = await getOrComputeCell(exchange, timeframe, coin, scorer, snapshotTtlMs);
      } catch (err) {
        // Cell isolation: skip + tally, debug log only — NO Telegram (no-TG-on-completion LAW).
        errors++;
        console.debug(
          `[trade-call-scanner] cell skipped ${exchange}/${coin}/${timeframe}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
  const partial = await raceDeadline(Promise.allSettled(tasks), deadlineMs);

  const computed = cells.filter((c): c is ScanScore => c !== null);
  const holds = computed.filter((c) => c.call === 'HOLD').length;

  let eligible = computed.filter((c) => c.call !== 'HOLD');
  if (minConfidence != null) eligible = eligible.filter((c) => c.confidence >= minConfidence);
  eligible = [...eligible].sort((a, b) => b.confidence - a.confidence);

  let ordered: ScanScore[] = eligible;
  if (includeHolds) {
    const sortedHolds = computed.filter((c) => c.call === 'HOLD').sort((a, b) => b.confidence - a.confidence);
    ordered = [...eligible, ...sortedHolds];
  }
  // Output order stays confidence-desc (the verdict order) — the lens picked the
  // UNIVERSE, not the display order. Project each cached SCORE at OUTPUT: bare
  // (toScanCallItem) or enriched (enrichScanCall, non-HOLD only when includeReasoning),
  // then attach the lens-varying rank echo. HOLDs stay bare + free even in enriched
  // mode. The cache cell is untouched ⇒ an enriched-then-bare scan leaves no stale.
  const sliced = ordered.slice(0, limit);
  const rm = rankMap; // const alias so TS narrows inside the .map closure
  const calls: ScanCallItem[] = sliced.map((score) => {
    const base: ScanCallItem =
      includeReasoning && score.call !== 'HOLD'
        ? enrichScanCall(score, exchange)
        : toScanCallItem(score, exchange);
    return rm ? attachRank(base, rm.get(score.coin)) : base;
  });
  const eligible_non_hold = calls.filter((c) => c.call !== 'HOLD').length;

  return { scanned, eligible_non_hold, holds, errors, partial, calls };
}

// ── Test seams (underscore-prefixed; non-public) ──

/** Inject a deterministic scorer in place of the live `getTradeSignal` path. */
export function _setScanScorerForTest(fn: ScanScorer | null): void {
  _scorerOverride = fn;
}

/** Reset all scanner caches (snapshots, in-flight, universe fresh + last-known-good). */
export function _clearScanCaches(): void {
  snapshots.clear();
  inflightCells.clear();
  lastKnownGoodUniverse.clear();
  universeCache?.clear();
}

/** Expire only the fresh universe cache, preserving last-known-good (stale-on-error tests). */
export function _expireUniverseFresh(): void {
  universeCache?.clear();
}
