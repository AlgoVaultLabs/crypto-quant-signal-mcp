/**
 * scan-shared.ts — SCAN-MARKET-REGIMES-W1-V2 CH2.
 *
 * The ONE implementation of what every venue screener shares with `scan_trade_calls`:
 *
 *   • the venue liquidity map behind `minLiquidityUsd` (and the floor applied over it);
 *   • the rank-lens echo a `rankBy` scan attaches to each row;
 *   • the quota envelope — the wall a refused caller sees, and the `quota` block a served caller's
 *     `_algovault` carries.
 *
 * WHY A MODULE AND NOT A COPY. `scan_market_regimes` needs all three with the SAME semantics a
 * `scan_trade_calls` caller already relies on: a floor that default-DENIES when the universe read
 * fails, an echo carrying exactly the lens fields (never a funding figure outside a funding lens), and
 * a quota wall whose horizon follows the meter that refused. Each of those was a separate fix wave the
 * first time; a second hand copy would re-open every one of them on the day the two drift. So they are
 * extracted from `trade-call-scanner.ts` / `scan-trade-calls.ts` verbatim, and `scan_trade_calls`'
 * output is pinned byte-identical by goldens recorded from the pre-extraction code
 * (`tests/scan-market-regimes.test.ts`, "AC2.2").
 *
 * WHAT STAYS WITH THE CALLER. Each tool still stamps its own `_algovault: withAuthState(...)` — the
 * stamp is the tool's identity (`tool`, `version`, `session_id`), and
 * `tests/auth-refusal-mcp.test.ts` counts the stamped sites per tool module. The builders here return
 * everything else, in the exact key order the envelope has always had, so the caller's
 * `{ ...builder(), _algovault }` is the historical object.
 *
 * QUOTA SURFACES. The quota primitives this module now calls are registered against it in
 * `src/lib/quota-surfaces.ts` (rows `refusal:scan_trade_calls` / `envelope:scan_trade_calls`, whose
 * `module` moved here with the code). `scripts/check-quota-surface-conformance.mjs` refuses an
 * unregistered call site, so the move could not have left the gate behind.
 */
import { fetchVenueUniverse, effectiveLiquidityUsd } from './exchange-universe.js';
import { monthResetAtMs, periodStartMs, utcDayResetAtMs, requestClientProfile, type TrackCallResult } from './license.js';
import { buildQuotaNoticeMessage, buildQuotaSuggestedAction, quotaNoticeFacts } from './quota-notice.js';
import { buildReferralHint, type ReferralHint } from './nudge-copy.js';
import { buildSuggestedX402, isX402NudgeEnabled } from './x402-nudge.js';
import { bindingMeter } from './binding-meter.js';
import type { RankedAsset } from './rank-metrics.js';
import type { OiBasis } from './oi-snapshots.js';
import type { PromotedVenueId } from './capabilities.js';
import type { LicenseInfo, QuotaState, SuggestedX402 } from '../types.js';

// ── Venue liquidity (FIX-CONVICTION-CALL-POSTS-W1, moved verbatim) ──────────────────────────────
// 60s TTL, matching `scan_funding_arb`'s per-leg gate cache. Only consulted when a caller actually
// passes `minLiquidityUsd`, so the default scan path performs no extra fetch.
const LIQUIDITY_TTL_MS = 60_000;
const liquidityCache = new Map<string, { at: number; byCoin: Map<string, number> }>();

/** Test seam, matching `_setScorerForTest` et al.: when set, the floor reads this instead of the
 *  live universe, so unit tests never touch the network. */
let _liquidityMapOverride: ((exchange: PromotedVenueId) => Map<string, number>) | null = null;
export function _setLiquidityMapForTest(fn: ((exchange: PromotedVenueId) => Map<string, number>) | null): void {
  _liquidityMapOverride = fn;
  liquidityCache.clear();
}

/** coin → USD liquidity on `exchange`. Fail-soft to an EMPTY map, which makes the floor
 *  default-DENY rather than silently admitting an ungated universe. */
export async function getVenueLiquidityUsd(exchange: PromotedVenueId): Promise<Map<string, number>> {
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
      `[scan-shared] liquidity universe fetch failed for ${exchange} — floor will deny all:`,
      err instanceof Error ? err.message : err,
    );
  }
  liquidityCache.set(exchange, { at: now, byCoin });
  return byCoin;
}

/**
 * The floor itself: the coins whose liquidity clears `minLiquidityUsd`, order preserved. An unknown
 * coin scores 0, so an unreachable universe admits nothing — the default-DENY both screeners share.
 * Callers skip this entirely when the floor is omitted or 0, which keeps the no-floor path fetch-free.
 */
export async function applyLiquidityFloor(
  exchange: PromotedVenueId,
  coins: readonly string[],
  minLiquidityUsd: number,
): Promise<string[]> {
  const liquidity = await getVenueLiquidityUsd(exchange);
  return coins.filter((c) => (liquidity.get(c) ?? 0) >= minLiquidityUsd);
}

// ── Rank-lens echo (SCAN-RANKBY-W1, moved verbatim from attachRank) ─────────────────────────────

/** The lens fields a `rankBy` row may carry. The ONE list — `attachRank` and the regime screener both
 *  project through `applyRankEcho`, so neither can grow a field the other lacks. */
export interface RankEchoFields {
  rank_value?: number;
  change_24h_pct?: number;
  volume_24h?: number;
  funding_rate?: number;
  funding_apr?: number | null;
  atrp?: number;
  oi_change_pct?: number;
  oi_change_window?: string;
  oi_change_basis?: OiBasis;
}

/**
 * Copy the lens echo for `ranked` onto `out` (allow-list: explicit field copy, never a spread) and
 * return it. `ranked` absent, or the default `oi` lens, ⇒ `out` unchanged — the verdict-only shape.
 * Only the typed field(s) for THIS lens are emitted; never any `outcome_*`.
 */
export function applyRankEcho<T extends RankEchoFields>(out: T, ranked: RankedAsset | undefined): T {
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

// ── Quota envelope (OPS-QUOTA-EXHAUSTION-NOTICE-W1 · OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1) ─────

/** A screener's quota wall, minus the caller-stamped `_algovault`. Field order is the wire order. */
export interface ScanQuotaWallBody {
  error: 'quota_exhausted';
  /**
   * OPS-QUOTA-EXHAUSTION-NOTICE-W1: aligned to the ONE code every other surface emits. It was
   * lowercase `tier_limit_reached` on the scanner and `TIER_LIMIT_REACHED` everywhere else, so an agent
   * branching on the code needed two branches for one event. `error` keeps its original lowercase
   * `quota_exhausted` value, so a consumer matching on THAT is unaffected.
   */
  code: 'TIER_LIMIT_REACHED';
  message: string;
  /** `QuotaState` — a COMPOSITE matching `_algovault.quota`, one meter per sub-object (instance 13). */
  quota: QuotaState;
  usage_display: string;
  resets_at: string;
  retry_after_days: number;
  /** Instance 14 — both from the SAME `quotaNoticeFacts` the message renders from. */
  limit: 'daily' | 'monthly';
  /** Present ONLY on a daily wall — absence is the signal that days is the right horizon. */
  retry_after_hours?: number;
  /** W4-R2 CH1: commerce field — absent for a `restricted` client profile (as are the two below). */
  recommended_path?: 'subscription' | 'x402';
  suggested_action: string;
  /** REFERRAL-INPRODUCT-NUDGE-W1: the limit moment carries the structured referral hint. */
  referral_hint?: ReferralHint;
  /** FUNNEL-FIX-AGENT-X402-NUDGE-W1 (Q4): omitted when the nudge is off, no rail is live, or the tool
   *  has no x402 price (`buildSuggestedX402` returns undefined for `x402: null`). */
  suggested_x402?: SuggestedX402;
}

/**
 * The quota wall for a screener the entry `checkQuota` refused. Moved verbatim from
 * `runScanTradeCall`; `tool` is the only new input — it names the x402 branch, nothing else.
 */
export function buildScanQuotaWall(
  tool: string,
  entry: TrackCallResult,
  license: LicenseInfo,
  refCode: string | null,
): ScanQuotaWallBody {
  // Limit moment (the scan wall): referral-prominent message + structured hint.
  // FUNNEL-FIX-AGENT-X402-NUDGE-W1 (Q4): + the additive in-protocol x402 branch, dark behind
  // X402_NUDGE_ENABLED, omitted when no public rail is live (default-deny ⇒ envelope unchanged).
  // OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH2 (instance 11): the wall discriminator is hoisted
  // ABOVE the nudge, because the nudge's noun projects from it — one value, read by both.
  const isDailyWall = entry.limit === 'daily'
    && typeof entry.daily_used === 'number'
    && typeof entry.daily_total === 'number';
  // GROWTH-AGENT-SIGNIN-OAUTH-W4-R2 CH1: the caller's platform profile decides the commerce fields —
  // a `restricted` wall states usage and when access returns, with no rail, path or referral.
  const { commerce } = requestClientProfile();
  const open = commerce === 'open';
  const suggestedX402 = open && isX402NudgeEnabled()
    ? buildSuggestedX402(tool, isDailyWall ? 'daily' : 'monthly')
    : undefined;
  // OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1-R2 CH3 (Fix 2): the discriminator and its pair travel
  // TOGETHER. A `wall` on its own would render the daily noun over the monthly numbers — the same
  // coupling `errors.ts` enforces through its `isDaily` triple.
  const noticeCtx = {
    meter: 'calls' as const,
    used: isDailyWall ? (entry.daily_used as number) : entry.used,
    limit: isDailyWall ? (entry.daily_total as number) : entry.total,
    wall: isDailyWall ? ('daily' as const) : ('monthly' as const),
    // The reset instant belongs to the wall that refused. `utcDayResetAtMs()` is the same derivation
    // the daily meter enforces against, so `resets_at` cannot disagree with `retry_after_hours`.
    resetAtMs: isDailyWall ? utcDayResetAtMs() : monthResetAtMs(license),
    periodStartMs: periodStartMs(license),
    referralCode: refCode,
    x402: suggestedX402,
    ...(open ? {} : { commerce }),
  };
  const facts = quotaNoticeFacts(noticeCtx);
  return {
    error: 'quota_exhausted',
    code: 'TIER_LIMIT_REACHED',
    message: buildQuotaNoticeMessage(noticeCtx),
    // OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH2 (instance 13, Q6): a COMPOSITE matching
    // `_algovault.quota` exactly — one meter per sub-object, `binding` naming the governing wall.
    quota: {
      used: entry.used,
      total: entry.total,
      remaining: Math.max(0, entry.total - entry.used),
      resets_at: new Date(monthResetAtMs(license)).toISOString(),
      ...(isDailyWall
        ? {
            daily: {
              used: entry.daily_used as number,
              total: entry.daily_total as number,
              remaining: Math.max(0, (entry.daily_total as number) - (entry.daily_used as number)),
              resets_at: new Date(utcDayResetAtMs()).toISOString(),
            },
          }
        : {}),
      binding: isDailyWall ? ('daily' as const) : ('monthly' as const),
    },
    usage_display: facts.usage_display,
    resets_at: facts.resets_at,
    retry_after_days: facts.retry_after_days,
    // Instance 14: both from the SAME `facts` already computed above — never a second derivation.
    // Spread-on-presence for the hours field keeps the MONTHLY envelope's key set unchanged.
    limit: facts.limit,
    ...(typeof facts.retry_after_hours === 'number' ? { retry_after_hours: facts.retry_after_hours } : {}),
    ...(open ? { recommended_path: facts.recommended_path } : {}),
    suggested_action: buildQuotaSuggestedAction(noticeCtx),
    ...(open ? { referral_hint: buildReferralHint({ from: 'limit', code: refCode }) } : {}),
    ...(suggestedX402 ? { suggested_x402: suggestedX402 } : {}),
  };
}

/**
 * The post-charge `quota` block of a served screener's `_algovault`. Moved verbatim from
 * `runScanTradeCall` (OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH2, instance 10): the monthly
 * used/total/remaining + `resets_at`, plus the DAILY pair and `binding` when a daily meter exists —
 * spread-on-presence, so the no-daily-meter shape is unchanged.
 *
 * `bindingMeter()` is the ONE derivation of "which meter binds"; it returns `null` for an unmetered
 * tier rather than a misleading 0, which an inline ratio comparison would get wrong.
 */
export function buildScanQuotaState(tracked: TrackCallResult, license: LicenseInfo): QuotaState {
  const trackedBinding = bindingMeter(
    { used: tracked.used, limit: tracked.total, resetAtMs: monthResetAtMs(license) },
    typeof tracked.daily_used === 'number' && typeof tracked.daily_total === 'number'
      ? { used: tracked.daily_used, limit: tracked.daily_total, resetAtMs: utcDayResetAtMs() }
      : null,
  );
  return {
    used: tracked.used,
    total: tracked.total,
    remaining: tracked.remaining,
    resets_at: new Date(monthResetAtMs(license)).toISOString(),
    ...(trackedBinding?.daily && Number.isFinite(trackedBinding.daily.resetAtMs)
      ? {
          daily: {
            used: trackedBinding.daily.used,
            total: trackedBinding.daily.limit,
            remaining: Math.max(0, trackedBinding.daily.limit - trackedBinding.daily.used),
            resets_at: new Date(trackedBinding.daily.resetAtMs).toISOString(),
          },
          binding: trackedBinding.binding,
        }
      : {}),
  };
}
