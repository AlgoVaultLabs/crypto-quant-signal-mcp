/**
 * OPS-QUOTA-EXHAUSTION-NOTICE-W1 (R5) — the free-tier exhaustion notice, pinned per surface.
 *
 * Two jobs:
 *   1. Pin the NOTICE on every surface a free caller can hit — message present, `code` stable,
 *      reset date COMPUTED (not a hardcoded interval), no internal metric leaked, no teaser.
 *   2. REGRESSION-LOCK the operator-FROZEN cutoff: at the cap, both HOLD and non-HOLD are
 *      refused. That behaviour was previously only incidental — nothing failed if a future
 *      wave added a "HOLDs are free at the wall" pass-through, which is exactly the softening
 *      the operator ruled out.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TierLimitReachedError, buildTierLimitPayload } from '../../src/lib/errors.js';
import {
  buildQuotaNoticeMessage,
  buildQuotaSuggestedAction,
  quotaNoticeFacts,
  recommendPath,
  type QuotaNoticeContext,
} from '../../src/lib/quota-notice.js';
import { buildChatQuotaNotice } from '../../src/lib/chat-rate-limit.js';
import { withQuotaState } from '../../src/lib/tier-warning.js';
import { PLANS, subscriptionBreakEvenCalls, FREE_MONTHLY_CALLS } from '../../src/lib/plans.js';
import { getMonthlyQuota } from '../../src/lib/license.js';
import type { SuggestedX402, AlgoVaultMeta } from '../../src/types.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-02T09:13:22.000Z');
const RESET_AT = NOW + 22 * DAY; // 2026-08-24T09:13:22Z

const LIVE_RAIL: SuggestedX402 = {
  tool: 'get_trade_call',
  instructions: 'pay per call',
  primary: {
    rail: 'x402_bazaar', label: 'CDP x402 Bazaar (Base/USDC)', method: 'POST',
    url: 'https://api.algovault.com/x402/get_trade_call',
    network: 'eip155:8453', asset: 'USDC', price_usd: 0.02, scheme: 'exact',
  },
  alternatives: [],
};

/** A caller who burned the whole free allowance in ~1 day → sustained volume. */
const HEAVY: QuotaNoticeContext = {
  meter: 'calls', used: FREE_MONTHLY_CALLS, limit: FREE_MONTHLY_CALLS, resetAtMs: RESET_AT, nowMs: NOW,
  periodStartMs: NOW - 1 * DAY, referralCode: null, x402: LIVE_RAIL,
};
/** A caller who took the full 30-day window to burn the same allowance → bursty / low volume. */
const LIGHT: QuotaNoticeContext = { ...HEAVY, periodStartMs: NOW - 30 * DAY };

describe('R2 — every surface carries the four required facts', () => {
  it('1. WHAT HAPPENED — the message states usage as N/limit', () => {
    expect(buildQuotaNoticeMessage(HEAVY)).toContain(`Free monthly quota used: ${FREE_MONTHLY_CALLS}/${FREE_MONTHLY_CALLS}`);
    expect(quotaNoticeFacts(HEAVY).usage_display).toBe(`${FREE_MONTHLY_CALLS}/${FREE_MONTHLY_CALLS}`);
  });

  it('2. WHEN IT RETURNS — a real date, COMPUTED from the reset instant', () => {
    const msg = buildQuotaNoticeMessage(HEAVY);
    expect(msg).toContain('Access returns 2026-08-24 (22 days)');
    expect(quotaNoticeFacts(HEAVY).resets_at).toBe('2026-08-24T09:13:22.000Z');
  });

  it('2b. the date MOVES with the caller — it is not a hardcoded interval', () => {
    // The whole failure mode this guards: an implementation that prints "30 days" or
    // "today + 30" passes a naive assertion while being wrong for every real caller, whose
    // rolling window is anchored on their OWN first call.
    const later = { ...HEAVY, resetAtMs: NOW + 3 * DAY };
    expect(buildQuotaNoticeMessage(later)).toContain('Access returns 2026-08-05 (3 days)');
    expect(quotaNoticeFacts(later).retry_after_days).toBe(3);
    // ...and a distinct caller with a distinct anchor gets a distinct date.
    const other = { ...HEAVY, resetAtMs: Date.parse('2026-09-11T00:00:00.000Z') };
    expect(buildQuotaNoticeMessage(other)).toContain('Access returns 2026-09-11');
  });

  it('2c. an already-elapsed reset floors at 0 days rather than going negative', () => {
    expect(quotaNoticeFacts({ ...HEAVY, resetAtMs: NOW - DAY }).retry_after_days).toBe(0);
  });

  it('3. WHAT TO DO — both paths, each a working link, ranked by measured volume', () => {
    const heavy = buildQuotaNoticeMessage(HEAVY);
    expect(heavy).toContain('Recommended for sustained volume: Starter');
    expect(heavy).toContain('https://api.algovault.com/signup?plan=starter&upgrade_from=limit');
    expect(heavy).toContain('https://api.algovault.com/x402/get_trade_call'); // still offered
    expect(recommendPath(HEAVY)).toBe('subscription');

    // PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (R-B amended 2026-08-09): the SECOND arm, reachable
    // from the same wall. Break-even is `priceUsdMonthly / perCall` = 9.99 / 0.02 = 500; the free
    // cap is 200. LIGHT burned the whole allowance across the full 30-day window, so it projects
    // 200/mo — below break-even, where paying per call genuinely IS cheaper ($4.00 on the rail
    // versus $9.99 on the plan). Both arms are asserted from the wall on purpose: at the briefly-
    // held cap of 500 the two numbers collided and this arm was unreachable, which is exactly the
    // kind of dead branch that rots unnoticed.
    const light = buildQuotaNoticeMessage(LIGHT);
    expect(light).toContain('Recommended at your volume: pay per call');
    expect(recommendPath(LIGHT)).toBe('x402');
  });

  it('3a. the boundary is the break-even itself, not a hardcoded number', () => {
    // Guards the thing a collision could hide: if `recommendPath` silently lost its ability to
    // rank either path first, a single-arm suite would still pass. Rank a caller whose PROJECTION
    // is genuinely below break-even and require the other answer, then walk the boundary.
    const lowVolume = { ...HEAVY, used: 100, periodStartMs: NOW - 30 * DAY };
    expect(recommendPath(lowVolume)).toBe('x402');
    expect(buildQuotaNoticeMessage(lowVolume)).toContain('Recommended at your volume: pay per call');
    const be = subscriptionBreakEvenCalls(0.02) as number;
    expect(recommendPath({ ...HEAVY, used: be - 1, periodStartMs: NOW - 30 * DAY })).toBe('x402');
    expect(recommendPath({ ...HEAVY, used: be, periodStartMs: NOW - 30 * DAY })).toBe('subscription');
  });

  it('3b. the ranking is derived from the two LIVE prices, not a hardcoded threshold', () => {
    // Break-even = plan price / per-call price. Both come from their own SoT, so moving
    // either price moves the recommendation with zero code change.
    expect(subscriptionBreakEvenCalls(0.02)).toBe(Math.round(PLANS.starter.priceUsdMonthly / 0.02));
    // A rail that is 10x cheaper per call pushes the same caller the other way.
    const cheap = { ...LIGHT, x402: { ...LIVE_RAIL, primary: { ...LIVE_RAIL.primary, price_usd: 0.002 } } };
    expect(recommendPath(cheap)).toBe('x402');
    // A rail that is 10x dearer makes the subscription win even for the light caller.
    const dear = { ...LIGHT, x402: { ...LIVE_RAIL, primary: { ...LIVE_RAIL.primary, price_usd: 0.2 } } };
    expect(recommendPath(dear)).toBe('subscription');
  });

  it('3c. a DARK rail is never advertised — no rail ⇒ no x402 prose, no x402 action', () => {
    // The pre-wave `scan_trade_calls` copy promised "or pay per call via x402" on EVERY wall,
    // whether or not a rail was live. Absence of the rail must remove the offer, not just the
    // structured field.
    const noRail: QuotaNoticeContext = { ...HEAVY, x402: undefined };
    expect(buildQuotaNoticeMessage(noRail)).not.toContain('x402');
    expect(buildQuotaSuggestedAction(noRail)).not.toContain('x402');
    expect(recommendPath(noRail)).toBe('subscription');
  });

  it('4. a stable code + the structured-error `suggested_<action>` field', () => {
    const err = new TierLimitReachedError({
      currentUsage: 100, monthlyLimit: 100, tier: 'free',
      suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter',
      resetAtMs: RESET_AT, nowMs: NOW, periodStartMs: NOW - DAY, tool: 'get_trade_call',
    });
    const p = buildTierLimitPayload(err, { suggestedX402: LIVE_RAIL });
    expect(p.code).toBe('TIER_LIMIT_REACHED');
    expect(p.error_code).toBe('TIER_LIMIT_REACHED');
    expect(p.suggested_action.length).toBeGreaterThan(0);
    // Always closes on the do-nothing fallback so a caller is never left without a next step.
    expect(p.suggested_action).toContain('wait until 2026-08-24');
  });

  it('the notice NEVER inlines a subscription price literal (it links instead)', () => {
    // AC3: a dollar figure in the copy rots the moment pricing moves — and this is the single
    // highest-intent surface the product has, so stale copy here is the costliest kind.
    for (const ctx of [HEAVY, LIGHT, { ...HEAVY, x402: undefined }]) {
      const msg = buildQuotaNoticeMessage(ctx);
      expect(msg).not.toContain(`$${PLANS.starter.priceUsdMonthly}`);
      expect(msg).not.toContain('$9.99');
    }
    // The plan's ALLOWANCE is fine — it is read from the SoT, never typed.
    expect(buildQuotaNoticeMessage(HEAVY)).toContain(`${PLANS.starter.monthlyCalls.toLocaleString('en-US')} calls/month`);
  });

  it('AC6 — no internal metric and no signal teaser leaks into any notice', () => {
    const err = new TierLimitReachedError({
      currentUsage: 100, monthlyLimit: 100, tier: 'free',
      suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter',
      resetAtMs: RESET_AT, nowMs: NOW, tool: 'get_trade_call',
    });
    const surfaces = [
      JSON.stringify(buildTierLimitPayload(err, { suggestedX402: LIVE_RAIL })),
      JSON.stringify(buildChatQuotaNotice('free', { limit: 10, used: 10, resetAt: new Date(RESET_AT) })),
      buildQuotaNoticeMessage(HEAVY),
      buildQuotaSuggestedAction(HEAVY),
    ];
    for (const s of surfaces) {
      expect(s).not.toContain('outcome_return_pct');
      expect(s).not.toContain('outcome_price');
      expect(s.toLowerCase()).not.toContain('win rate');
      expect(s.toLowerCase()).not.toContain('win_rate');
      // No teaser: the wall must not hint that an actionable verdict existed.
      expect(s).not.toMatch(/\b(BUY|SELL|HOLD)\b/);
      expect(s.toLowerCase()).not.toContain('confidence');
    }
  });
});

describe('R2 — the chat meter renders the same contract with its own semantics', () => {
  const chat = { limit: 10, used: 10, resetAt: new Date(Date.parse('2026-09-01T00:00:00.000Z')) };

  it('states N/10 and its own CALENDAR-month reset date', () => {
    const n = buildChatQuotaNotice('free', chat);
    expect(n.usage_display).toBe('10/10');
    expect(n.resets_at).toBe('2026-09-01T00:00:00.000Z');
    expect(n.message).toContain('Free monthly chat quota used: 10/10');
    expect(n.message).toContain('Access returns 2026-09-01');
  });

  it('keeps its own stable code — the two meters are genuinely different events', () => {
    expect(buildChatQuotaNotice('free', chat).code).toBe('CHAT_QUOTA_EXHAUSTED');
  });

  it('routes its upgrade CTA through the funnel (it pointed at #pricing with no attribution)', () => {
    const n = buildChatQuotaNotice('free', chat);
    expect(n.upgrade_url).toContain('upgrade_from=limit_chat');
    expect(n.upgrade_url).not.toContain('#pricing');
    expect(n.suggested_action.length).toBeGreaterThan(0);
  });

  it('does NOT offer referral bonus calls — those credit the CALL meter, not chat', () => {
    // Offering them here would promise relief that never arrives on this meter.
    const n = buildChatQuotaNotice('free', chat);
    expect(n.message.toLowerCase()).not.toContain('refer a friend');
    expect(n.message.toLowerCase()).not.toContain('bonus calls');
  });

  it('tells the caller the trading tools still work (the meters are independent)', () => {
    expect(buildChatQuotaNotice('free', chat).message).toContain('separate quota and are unaffected');
  });

  it('retains every pre-wave field so existing consumers are unbroken', () => {
    const n = buildChatQuotaNotice('free', chat);
    expect(n.code).toBe('CHAT_QUOTA_EXHAUSTED');
    expect(n.limit).toBe(10);
    expect(n.tier).toBe('free');
    expect(typeof n.retry_after_days).toBe('number');
    expect(typeof n.message).toBe('string');
    expect(typeof n.upgrade_url).toBe('string');
  });
});

describe('R3 — `_algovault.quota` is strictly additive', () => {
  const base: AlgoVaultMeta = {
    version: '1.24.1', tool: 'get_trade_call',
    compatible_with: ['crypto-quant-risk-mcp'], session_id: 'v2:abc',
  };

  it('attaches usage / remaining / reset instant on a metered caller', () => {
    const m = withQuotaState(base, { tier: 'free', used: 42, total: 100, resetAtMs: RESET_AT });
    expect(m.quota).toEqual({ used: 42, total: 100, remaining: 58, resets_at: '2026-08-24T09:13:22.000Z' });
  });

  it('AC4 — removing the field yields the pre-wave block BYTE-IDENTICALLY (proven, not asserted)', () => {
    const m = withQuotaState(base, { tier: 'free', used: 42, total: 100, resetAtMs: RESET_AT });
    const { quota: _dropped, ...withoutNewField } = m;
    expect(JSON.stringify(withoutNewField)).toBe(JSON.stringify(base));
  });

  it('is OMITTED for unmetered tiers (Infinity has no honest JSON form) and bot-internal', () => {
    expect(withQuotaState(base, { tier: 'x402', used: 0, total: Infinity, resetAtMs: RESET_AT })).toBe(base);
    expect(withQuotaState(base, { tier: 'internal', used: 0, total: Infinity, resetAtMs: RESET_AT })).toBe(base);
    expect(withQuotaState(base, { tier: 'free', used: 1, total: 100, resetAtMs: RESET_AT, isBotInternal: true })).toBe(base);
  });

  it('default-denies on malformed input rather than emitting a broken field', () => {
    expect(withQuotaState(base, { tier: 'free', used: 1, total: 0, resetAtMs: RESET_AT })).toBe(base);
    expect(withQuotaState(base, { tier: 'free', used: -1, total: 100, resetAtMs: RESET_AT })).toBe(base);
    expect(withQuotaState(base, { tier: 'free', used: 1, total: 100, resetAtMs: NaN })).toBe(base);
  });

  it('paid tiers get it too — 412/3000 is as useful to them as to free', () => {
    const m = withQuotaState(base, { tier: 'starter', used: 412, total: getMonthlyQuota('starter'), resetAtMs: RESET_AT });
    expect(m.quota).toMatchObject({ used: 412, total: PLANS.starter.monthlyCalls, remaining: PLANS.starter.monthlyCalls - 412 });
  });
});

describe('the plan SoT is the one derivation', () => {
  it('getMonthlyQuota projects from PLANS — the allowances cannot diverge', () => {
    expect(getMonthlyQuota('starter')).toBe(PLANS.starter.monthlyCalls);
    expect(getMonthlyQuota('pro')).toBe(PLANS.pro.monthlyCalls);
    expect(getMonthlyQuota('enterprise')).toBe(PLANS.enterprise.monthlyCalls);
    expect(getMonthlyQuota('free')).toBe(FREE_MONTHLY_CALLS);
  });

  // PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (R-B, amended by Mr.1 2026-08-09): re-frozen at 200,
  // raised from 100 in the same deploy that made every verdict chargeable so no tracker is newly
  // walled. The 2026-08-08 value was 500 and never shipped.
  it('the free tier stays at 200 — operator-FROZEN', () => {
    expect(FREE_MONTHLY_CALLS).toBe(200);
    expect(getMonthlyQuota('free')).toBe(200);
  });

  // The relationship the amendment restored. `recommendPath` compares a projection against
  // break-even; when the free cap EQUALS break-even the x402 arm is unreachable from the monthly
  // wall by construction (see plans.ts). Pin the inequality itself, so a future cap change that
  // silently recreates the collision fails HERE with the reason, not three files away.
  it('the free cap sits BELOW break-even — so both recommendation arms stay reachable', () => {
    const be = subscriptionBreakEvenCalls(0.02) as number;
    expect(be).toBe(500);
    expect(FREE_MONTHLY_CALLS).toBeLessThan(be);
  });

  it('no live per-call price ⇒ no break-even to compute (default-deny, not a guess)', () => {
    expect(subscriptionBreakEvenCalls(undefined)).toBeNull();
    expect(subscriptionBreakEvenCalls(0)).toBeNull();
    expect(subscriptionBreakEvenCalls(Number.NaN)).toBeNull();
  });
});

// ── AC2: the FROZEN cutoff, regression-locked ──
//
// These drive the real tool entry gates against a real in-memory meter. The operator froze
// two things: the free tier stays at 100, and at exhaustion ALL calls stop — trade calls AND
// HOLDs. Nothing previously failed if a wave added a HOLD pass-through or a grace band, so
// the frozen behaviour was resting on convention. It now fails a test.
describe('AC2 — at the cap, EVERY call is refused (HOLD and non-HOLD alike)', () => {
  let license: typeof import('../../src/lib/license.js');
  let getTradeSignal: typeof import('../../src/tools/get-trade-call.js')['getTradeSignal'];
  let getMarketRegime: typeof import('../../src/tools/get-market-regime.js')['getMarketRegime'];
  let scanFundingArb: typeof import('../../src/tools/scan-funding-arb.js')['scanFundingArb'];
  let setSnapshot: (cells: unknown[]) => void;

  // A FRESH tracker key per case. `resetLicenseCache()` only clears the cached license — it
  // does NOT clear the in-memory `callTrackers` meter, so a shared key would carry 100 calls
  // into the next case and quietly turn every later assertion into a different scenario.
  let caseNo = 0;
  let FREE_KEYED: { tier: 'free'; key: string };

  beforeEach(async () => {
    license = await import('../../src/lib/license.js');
    ({ getTradeSignal } = await import('../../src/tools/get-trade-call.js'));
    ({ getMarketRegime } = await import('../../src/tools/get-market-regime.js'));
    ({ scanFundingArb } = await import('../../src/tools/scan-funding-arb.js'));
    // The trade-call suites time out unless the cross-asset grid snapshot is stubbed empty.
    const grid = await import('../../src/lib/cross-asset-grid.js');
    setSnapshot = grid._setSnapshotForTest as unknown as (cells: unknown[]) => void;
    setSnapshot([]);
    license.resetLicenseCache();
    FREE_KEYED = { tier: 'free', key: `av_free_frozen_cutoff_${++caseNo}` };
    // Drive the meter to exactly the cap.
    for (let i = 0; i < FREE_MONTHLY_CALLS; i++) license.trackCall(FREE_KEYED);
    expect(license.checkQuota(FREE_KEYED).allowed).toBe(false);
  });

  afterEach(() => {
    license.resetLicenseCache();
  });

  it('get_trade_call refuses BEFORE the verdict exists — so a HOLD cannot slip through', async () => {
    // The gate is deliberately at ENTRY, above any market work: at the cap the tool cannot
    // know whether this call would have been a HOLD, which is what makes "HOLDs are free at
    // the wall" structurally impossible rather than merely absent.
    await expect(getTradeSignal({ coin: 'BTC', timeframe: '1h', license: FREE_KEYED }))
      .rejects.toBeInstanceOf(TierLimitReachedError);
  });

  it('get_market_regime refuses at the cap', async () => {
    await expect(getMarketRegime({ coin: 'BTC', timeframe: '1h', license: FREE_KEYED }))
      .rejects.toBeInstanceOf(TierLimitReachedError);
  });

  it('scan_funding_arb refuses at the cap', async () => {
    await expect(scanFundingArb({ license: FREE_KEYED }))
      .rejects.toBeInstanceOf(TierLimitReachedError);
  });

  it('a REFUSED call is not charged — usage stays at the cap however often the wall is hit', async () => {
    // Pre-wave, get_market_regime + scan_funding_arb gated on the INCREMENTING trackCall, so
    // the Step-0 probe watched a caller's reported usage climb 101/100 → 102/100 → ... A notice
    // cannot honestly say "N/100" while N drifts past 100.
    for (let i = 0; i < 5; i++) {
      await expect(getMarketRegime({ coin: 'BTC', timeframe: '1h', license: FREE_KEYED })).rejects.toThrow();
      await expect(scanFundingArb({ license: FREE_KEYED })).rejects.toThrow();
      await expect(getTradeSignal({ coin: 'BTC', timeframe: '1h', license: FREE_KEYED })).rejects.toThrow();
    }
    const q = license.checkQuota(FREE_KEYED);
    expect(q.used).toBe(FREE_MONTHLY_CALLS);
    expect(q.allowed).toBe(false);
  });

  it('the refusal carries the full notice on every one of the three tools', async () => {
    const thrown: TierLimitReachedError[] = [];
    for (const call of [
      () => getTradeSignal({ coin: 'BTC', timeframe: '1h', license: FREE_KEYED }),
      () => getMarketRegime({ coin: 'BTC', timeframe: '1h', license: FREE_KEYED }),
      () => scanFundingArb({ license: FREE_KEYED }),
    ]) {
      await call().catch((e) => thrown.push(e as TierLimitReachedError));
    }
    expect(thrown).toHaveLength(3);
    for (const err of thrown) {
      expect(err.code).toBe('TIER_LIMIT_REACHED');
      expect(err.current_usage).toBe(FREE_MONTHLY_CALLS);
      expect(err.monthly_limit).toBe(FREE_MONTHLY_CALLS);
      expect(err.message).toContain(`Free monthly quota used: ${FREE_MONTHLY_CALLS}/${FREE_MONTHLY_CALLS}`);
      expect(err.message).toMatch(/Access returns \d{4}-\d{2}-\d{2} \(\d+ days\)/);
      expect(err.resets_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(err.suggested_action.length).toBeGreaterThan(0);
    }
  });
});

// ── OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1-R2 CH3 ────────────────────────────────────
//
// The recommendation divided a ONE-DAY numerator by a MULTI-DAY denominator: on a daily wall
// `used`/`limit` are the daily pair (this module's own contract) while `periodStartMs` is, and
// always was, the MONTHLY anchor, passed unconditionally by errors.ts. The error grew with how
// deep into the rolling month the daily wall fired — and it pushed the notice toward the MORE
// EXPENSIVE path for the caller most worth converting.
describe('CH3 — recommendPath projects from ONE meter', () => {
  const dailyCtx = (dailyUsed: number, periodStartMs: number): QuotaNoticeContext => ({
    meter: 'calls',
    used: dailyUsed,
    limit: 100,
    wall: 'daily',
    resetAtMs: RESET_AT,
    nowMs: NOW,
    // The MONTHLY anchor — present, as errors.ts passes it, and irrelevant to a daily projection.
    periodStartMs,
    x402: LIVE_RAIL,
  });

  /** The live boundary, derived — never the literal 500. */
  const breakEven = subscriptionBreakEvenCalls(LIVE_RAIL.primary.price_usd)!;
  const dailyBoundary = Math.ceil(breakEven / 30);

  it('the boundary is DERIVED from the plan + rail SoT, not hardcoded', () => {
    expect(breakEven).toBeGreaterThan(0);
    expect(Number.isFinite(breakEven)).toBe(true);
  });

  it('🎯 a 100/day caller walled on day 20 is recommended the SUBSCRIPTION', () => {
    // The defect: 100 / 20 elapsed days * 30 = 150 < break-even => x402, the dearer option.
    // Same meter: 100 * 30 = 3,000 >> break-even => subscription, genuinely ~6x cheaper.
    expect(recommendPath(dailyCtx(100, NOW - 20 * DAY))).toBe('subscription');
  });

  it('...and the verdict no longer moves with how deep into the month the wall fired', () => {
    // The tell-tale of the old arithmetic: identical daily burn, different answers by day.
    const byDay = [1, 5, 10, 20, 29].map((d) => recommendPath(dailyCtx(100, NOW - d * DAY)));
    expect(new Set(byDay).size).toBe(1);
    expect(byDay[0]).toBe('subscription');
  });

  it('a genuinely low-volume daily caller still gets x402 — both arms stay reachable', () => {
    expect(recommendPath(dailyCtx(dailyBoundary - 1, NOW - 3 * DAY))).toBe('x402');
  });

  it('pins BOTH sides of the live break-even boundary', () => {
    // plans.ts warns the free-cap/break-even relationship is load-bearing and coincidental, so
    // the boundary is pinned rather than assumed to sit anywhere in particular.
    expect(recommendPath(dailyCtx(dailyBoundary, NOW - 3 * DAY))).toBe('subscription');
    expect(recommendPath(dailyCtx(dailyBoundary - 1, NOW - 3 * DAY))).toBe('x402');
  });

  it('the MONTHLY arm is untouched — the anchor still drives it', () => {
    const monthly = (used: number, periodStartMs: number): QuotaNoticeContext => ({
      meter: 'calls', used, limit: FREE_MONTHLY_CALLS, wall: 'monthly',
      resetAtMs: RESET_AT, nowMs: NOW, periodStartMs, x402: LIVE_RAIL,
    });
    // A burst caller (whole allowance in a day) leads subscription; a slow one leads x402.
    expect(recommendPath(monthly(FREE_MONTHLY_CALLS, NOW - 1 * DAY))).toBe('subscription');
    expect(recommendPath(monthly(20, NOW - 29 * DAY))).toBe('x402');
  });

  it('an ABSENT wall still takes the monthly path (default, unchanged)', () => {
    const noWall: QuotaNoticeContext = {
      meter: 'calls', used: 20, limit: FREE_MONTHLY_CALLS, resetAtMs: RESET_AT, nowMs: NOW,
      periodStartMs: NOW - 29 * DAY, x402: LIVE_RAIL,
    };
    expect(recommendPath(noWall)).toBe('x402');
  });

  it('chat has one meter and is untouched — still subscription', () => {
    const chat = buildChatQuotaNotice('free', { limit: 10, used: 10, resetAt: new Date(RESET_AT) });
    expect(chat.code).toBe('CHAT_QUOTA_EXHAUSTED');
    expect(chat.suggested_action.length).toBeGreaterThan(0);
  });

  it('no dark rail: with no live rail the subscription leads and x402 is never advertised', () => {
    const noRail: QuotaNoticeContext = { ...dailyCtx(100, NOW - 20 * DAY), x402: undefined };
    expect(recommendPath(noRail)).toBe('subscription');
    expect(buildQuotaNoticeMessage(noRail)).not.toMatch(/x402/i);
  });
});

describe('CH3 — the daily wall renders the daily noun, pair and 00:00 UTC horizon', () => {
  const daily: QuotaNoticeContext = {
    meter: 'calls', used: 100, limit: 100, wall: 'daily',
    resetAtMs: NOW + 6 * 60 * 60 * 1000, nowMs: NOW, periodStartMs: NOW - 20 * DAY, x402: LIVE_RAIL,
  };

  it('the headline states the DAILY pair and the 00:00 UTC return', () => {
    const msg = buildQuotaNoticeMessage(daily);
    expect(msg).toContain('100/100');
    expect(msg).toContain('00:00 UTC');
    expect(msg).not.toMatch(/Access returns \d{4}-\d{2}-\d{2}/); // the monthly sentence
  });

  it('the facts carry retry_after_hours and limit=daily', () => {
    const f = quotaNoticeFacts(daily);
    expect(f.limit).toBe('daily');
    expect(f.retry_after_hours).toBeGreaterThanOrEqual(0);
    expect(f.recommended_path).toBe('subscription');
  });
});
