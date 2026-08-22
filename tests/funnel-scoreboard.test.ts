/**
 * H0-C4-MEASURE-CLOSE — unit tests for the always-on funnel scoreboard.
 *
 * Pure derivations are fixture-tested with NO DB / NO Stripe (dependency-injected
 * orchestrator). Covers the AC4 mandates:
 *   - known fixture → known 4 metrics + intent panel + micro-funnel collapse,
 *   - a cohort with <90d history → retention d90 = null (NEVER 0),
 *   - default-deny: a NaN / broken DB read → null, never a favorable number.
 */
import { describe, it, expect } from 'vitest';
import {
  getFunnelScoreboard,
  computeRetentionCurve,
  reconcileCounts,
  profilesComposition,
  safeRatio,
  safeCount,
  toEpochMs,
  bucketDaily,
  bucketWeeklyByChannel,
  projectClientActivity,
  classifyTierBucket,
  computeRetentionBreakdown,
  windowToDays,
  ragVerdict,
  lowConfidence,
  buildTransitions,
  pickBiggestLeak,
  getHumanFunnel,
  getAgentFunnel,
  getHoldUpside,
  FUNNEL_BENCHMARKS,
  type ScoreboardDeps,
  type RetentionSession,
  type FunnelStage,
} from '../src/lib/funnel-scoreboard.js';
import {
  aggregateQuotaWallRows,
  POOLED_QUOTA_WALL_EVENT_TYPES,
  QUOTA_WALL_EVENT_TYPES,
  QUOTA_WALL_PRESENT_SQL,
} from '../src/lib/funnel-snapshot.js';
import type { FunnelSnapshot } from '../src/lib/funnel-snapshot.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 9); // 2026-07-09

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('computeRetentionCurve', () => {
  it('returns null (not 0) for an immature window; derives d90 maturity date', () => {
    const sessions = [
      { firstSeenMs: NOW - 40 * DAY, lastSeenMs: NOW - 5 * DAY }, // span 35d, horizon 40d
      { firstSeenMs: NOW - 40 * DAY, lastSeenMs: NOW - 39 * DAY }, // span 1d, horizon 40d
      { firstSeenMs: NOW - 3 * DAY, lastSeenMs: NOW - 3 * DAY }, // horizon 3d (immature for all)
    ];
    const c = computeRetentionCurve(sessions, NOW);
    expect(c.d7).toBeCloseTo(0.5); // eligible {A,B}, retained {A}
    expect(c.d14).toBeCloseTo(0.5);
    expect(c.d30).toBeCloseTo(0.5);
    expect(c.d90).toBeNull(); // no session is 90d old → NULL, never 0
    expect(c.d90_matures_on).toBe('2026-08-28'); // earliest first_seen (now-40d) + 90d
    expect(c.cohort_size).toBe(3);
  });

  it('all windows null when every session is too young', () => {
    const c = computeRetentionCurve([{ firstSeenMs: NOW - 2 * DAY, lastSeenMs: NOW - 1 * DAY }], NOW);
    expect(c.d7).toBeNull();
    expect(c.d14).toBeNull();
    expect(c.d30).toBeNull();
    expect(c.d90).toBeNull();
  });

  it('empty cohort → all null, cohort_size null', () => {
    const c = computeRetentionCurve([], NOW);
    expect(c.d7).toBeNull();
    expect(c.cohort_size).toBeNull();
    expect(c.d90_matures_on).toBeNull();
  });
});

describe('safeRatio (default-deny)', () => {
  it('null on NaN / Infinity / null / zero denominator — never 0-coerced', () => {
    expect(safeRatio(1, 0)).toBeNull();
    expect(safeRatio(1, null)).toBeNull();
    expect(safeRatio(1, NaN)).toBeNull();
    expect(safeRatio(NaN, 10)).toBeNull();
    expect(safeRatio(null, 10)).toBeNull();
    expect(safeRatio(1, Infinity)).toBeNull();
    expect(safeRatio(1, 6)).toBeCloseTo(1 / 6);
  });
});

describe('safeCount / toEpochMs (default-deny coercion)', () => {
  it('safeCount rejects non-integers → null, parses valid', () => {
    expect(safeCount('not-a-number')).toBeNull();
    expect(safeCount(NaN)).toBeNull();
    expect(safeCount(undefined)).toBeNull();
    expect(safeCount('0x1')).toBeNull(); // hex string not accepted
    expect(safeCount('7')).toBe(7);
    expect(safeCount(6)).toBe(6);
  });
  it('toEpochMs handles epoch-number, epoch-string, ISO string, and Date', () => {
    expect(toEpochMs(NOW)).toBe(NOW);
    expect(toEpochMs(String(NOW))).toBe(NOW);
    expect(toEpochMs('2026-07-09T00:00:00.000Z')).toBe(NOW);
    expect(toEpochMs(new Date(NOW))).toBe(NOW);
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs('garbage')).toBeNull();
  });
});

describe('reconcileCounts (Stripe vs subscriber_profiles)', () => {
  it('1 vs 1 → not divergent, no artifact', () => {
    const r = reconcileCounts(1, 1);
    expect(r.divergent).toBe(false);
    expect(r.instrumentation_artifact).toBe(false);
  });
  it('>2× → instrumentation_artifact', () => {
    const r = reconcileCounts(5, 1);
    expect(r.instrumentation_artifact).toBe(true);
    expect(r.divergent).toBe(true);
  });
  it('>10 absolute → instrumentation_artifact even if <2×', () => {
    const r = reconcileCounts(30, 19); // 1.58× but gap 11
    expect(r.instrumentation_artifact).toBe(true);
  });
  it('stripe unavailable (null) → not divergent', () => {
    const r = reconcileCounts(null, 3);
    expect(r.stripe_total).toBeNull();
    expect(r.divergent).toBe(false);
  });
});

describe('bucketDaily / bucketWeeklyByChannel', () => {
  it('bucketDaily returns one entry per day, oldest→newest, counts in-window only', () => {
    const days = bucketDaily([NOW, NOW, NOW - 1 * DAY, NOW - 100 * DAY], NOW, 7);
    expect(days).toHaveLength(7);
    expect(days[days.length - 1]).toEqual({ date: '2026-07-09', count: 2 });
    expect(days[days.length - 2]).toEqual({ date: '2026-07-08', count: 1 });
    // the -100d row is out of the 7d window → uncounted
    expect(days.reduce((s, d) => s + d.count, 0)).toBe(3);
  });
  it('bucketWeeklyByChannel groups by Monday week + channel', () => {
    const wk = bucketWeeklyByChannel([
      { ms: NOW, channel: 'direct' },
      { ms: NOW, channel: 'tg_bot' },
      { ms: NOW - 7 * DAY, channel: 'direct' },
    ]);
    expect(wk.length).toBe(2);
    expect(wk[0].total).toBe(2); // newest week first
    expect(wk[0].by_channel.direct).toBe(1);
    expect(wk[0].by_channel.tg_bot).toBe(1);
  });
});

describe('classifyTierBucket', () => {
  it('paid when first_tier or tiers_seen carries any paid tier', () => {
    expect(classifyTierBucket('pro', 'pro')).toBe('paid');
    expect(classifyTierBucket('free', 'free,starter')).toBe('paid'); // ever-paid via tiers_seen
    expect(classifyTierBucket('x402', 'x402')).toBe('paid');
  });
  it('internal for the bot alert-engine; free otherwise', () => {
    expect(classifyTierBucket('internal', 'internal')).toBe('internal');
    expect(classifyTierBucket('free', 'free')).toBe('free');
    expect(classifyTierBucket(null, null)).toBe('free'); // default-free, never internal/paid by accident
  });
});

describe('computeRetentionBreakdown', () => {
  const sessions: RetentionSession[] = [
    { firstSeenMs: NOW - 40 * DAY, lastSeenMs: NOW - 5 * DAY, tierBucket: 'free', channel: 'claude' }, // retained
    { firstSeenMs: NOW - 40 * DAY, lastSeenMs: NOW - 39 * DAY, tierBucket: 'free', channel: 'claude' }, // not
    { firstSeenMs: NOW - 40 * DAY, lastSeenMs: NOW - 2 * DAY, tierBucket: 'paid', channel: 'unknown' }, // retained
    { firstSeenMs: NOW - 40 * DAY, lastSeenMs: NOW - 1 * DAY, tierBucket: 'internal', channel: 'untagged' }, // excluded
  ];
  it('excludes internal from every curve + counts it', () => {
    const b = computeRetentionBreakdown(sessions, NOW);
    expect(b.internal_excluded).toBe(1);
    expect(b.overall.cohort_size).toBe(3); // 4 − 1 internal
  });
  it('splits free vs paid', () => {
    const b = computeRetentionBreakdown(sessions, NOW);
    expect(b.by_tier.free.d7).toBeCloseTo(0.5); // 2 free eligible, 1 retained
    expect(b.by_tier.paid.d7).toBeCloseTo(1); // 1 paid eligible + retained
  });
  it('groups by channel, sorted by cohort size desc', () => {
    const b = computeRetentionBreakdown(sessions, NOW);
    expect(b.by_channel[0].channel).toBe('claude'); // 2 > 1
    expect(b.by_channel.find(c => c.channel === 'claude')?.curve.d7).toBeCloseTo(0.5);
    expect(b.by_channel.some(c => c.channel === 'untagged')).toBe(false); // internal-only channel dropped
  });
});

describe('V2 funnel pure helpers', () => {
  it('windowToDays maps windows; all → null', () => {
    expect(windowToDays('7')).toBe(7);
    expect(windowToDays('365')).toBe(365);
    expect(windowToDays('all')).toBeNull();
  });
  it('ragVerdict: green/amber/red vs benchmark; null → amber', () => {
    const b = { greenMin: 0.3, amberMin: 0.15, label: 'x' };
    expect(ragVerdict(0.4, b)).toBe('g');
    expect(ragVerdict(0.2, b)).toBe('a');
    expect(ragVerdict(0.05, b)).toBe('r');
    expect(ragVerdict(null, b)).toBe('a');
  });
  it('lowConfidence flags n<30 (not null)', () => {
    expect(lowConfidence(29)).toBe(true);
    expect(lowConfidence(30)).toBe(false);
    expect(lowConfidence(null)).toBe(false);
  });
  it('buildTransitions computes rate/drop/verdict/low-confidence; pickBiggestLeak = worst-vs-benchmark', () => {
    const stages: FunnelStage[] = [
      { key: 'a', label: 'A', sublabel: '', count: 100 },
      { key: 'b', label: 'B', sublabel: '', count: 6 },   // 6% — red vs 30%
      { key: 'c', label: 'C', sublabel: '', count: 1 },   // 16.7% — green vs 5%
    ];
    const benches = [FUNNEL_BENCHMARKS.human_click_to_signup, FUNNEL_BENCHMARKS.human_signup_to_paid];
    const trs = buildTransitions(stages, benches);
    expect(trs[0].rate).toBeCloseTo(0.06);
    expect(trs[0].drop).toBe(94);
    expect(trs[0].verdict).toBe('r');
    expect(trs[0].low_confidence).toBe(false); // n=100
    expect(trs[1].verdict).toBe('g');
    expect(trs[1].low_confidence).toBe(true); // n=6 < 30
    expect(pickBiggestLeak(trs, benches)?.from).toBe('A'); // A→B furthest below benchmark
  });
  it('buildTransitions: rate null when prior stage is 0/null (never divide-by-zero)', () => {
    const stages: FunnelStage[] = [
      { key: 'a', label: 'A', sublabel: '', count: 0 },
      { key: 'b', label: 'B', sublabel: '', count: 0 },
    ];
    const trs = buildTransitions(stages, [FUNNEL_BENCHMARKS.human_click_to_signup]);
    expect(trs[0].rate).toBeNull();
    expect(pickBiggestLeak(trs, [FUNNEL_BENCHMARKS.human_click_to_signup])).toBeNull();
  });
});

function funnelDeps(router: (sql: string, params: unknown[]) => unknown[]): ScoreboardDeps {
  return {
    snapshot: async () => stubSnapshot(),
    stripeCensus: async () => null,
    listProfiles: async () => [],
    usageStats: async () => ({}),
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => router(sql, params) as T[],
    now: () => NOW,
  };
}

describe('getHumanFunnel', () => {
  const deps = funnelDeps((sql) => {
    if (sql.includes("'track_record_viewed'")) return [{ c: 71 }];
    if (sql.includes("'landing_cta_clicked'")) return [{ c: 88 }];
    if (sql.includes('COUNT(*)') && sql.includes('FROM signup_attribution')) return [{ c: 100 }];
    if (sql.includes('referrer, utm_source FROM signup_attribution')) return [
      ...Array(88).fill({ channel: 'direct', referrer: null, utm_source: null }),
      ...Array(10).fill({ channel: 'tg_bot', referrer: null, utm_source: null }),
      { channel: 'direct', referrer: 'https://chatgpt.com/c/abc', utm_source: null }, // OPS-ATTRIBUTION-AI-REFERRAL-W1: AI via Referer
      { channel: 'direct', referrer: null, utm_source: 'chatgpt.com' },               // AI via utm (survives referer-strip)
    ];
    if (sql.includes('FROM free_keys')) return [{ c: 6 }];
    if (sql.includes('FROM subscriber_profiles')) return [{ c: 1 }];
    return [];
  });
  it('renders stages + proxy band + channel + biggest leak', async () => {
    const h = await getHumanFunnel('all', deps);
    expect(h.engagement_proxy).toMatchObject({ track_record_viewed: 71, landing_cta_clicked: 88 });
    expect(h.stages.map(s => s.count)).toEqual([100, 6, 1]);
    expect(h.transitions[0].rate).toBeCloseTo(0.06); // click→signup 6%
    expect(h.transitions[0].verdict).toBe('r');
    expect(h.biggest_leak?.from).toBe('Subscribe click');
    expect(h.by_channel[0]).toMatchObject({ channel: 'direct', count: 90 });
    expect(h.by_channel[0].pct).toBeCloseTo(0.9);
    // OPS-ATTRIBUTION-AI-REFERRAL-W1: AI-referral family = the 2 AI-classified signups (1 Referer + 1 utm), medium==='ai'
    expect(h.ai_referral.total).toBe(2);
    expect(h.ai_referral.by_source).toEqual([{ source: 'ai_chatgpt', count: 2, pct: 1 }]);
    expect(h.ai_referral.floor_note).toMatch(/FLOOR/);
  });
});

describe('getAgentFunnel', () => {
  const deps = funnelDeps((sql) => {
    if (sql.includes("'mcp_connect'")) return [{ c: 1000 }];
    if (sql.includes('FROM agent_sessions')) return [{ c: 800 }];
    if (sql.includes("'quota_hit_hard','quota_hit_block'")) return [{ c: 10 }];
    if (sql.includes("'quota_hit_soft'")) return [{ c: 20 }];
    if (sql.includes('FROM quota_usage')) return [{ c: 10 }];
    // OPS-X402-WALLET-ATTRIBUTION-W1: distinct wallets (exact conversion) vs payment count vs repeat-payers.
    // Keyed on the AGGREGATE, not on the normalisation expression. REVENUE-METER-TRUTH-W1 CH1 changed
    // it to `lower(trim(payer_wallet))`; the old exact-literal matcher then MISSED and fell through to
    // the `FROM processed_x402_payments` payment-count branch below, returning 7 as if it were the
    // wallet count. A substring matcher that can fall through to a sibling branch yields a wrong
    // answer rather than an error — `COUNT(DISTINCT` cannot collide with the `COUNT(*)` payment query.
    if (sql.includes('COUNT(DISTINCT')) return [{ c: 3 }];
    if (sql.includes('GROUP BY payer_wallet')) return [
      { payer_wallet: '0xrealpayer0000000000000000000000000000aa', c: 4 },
      { payer_wallet: '0xrealpayer0000000000000000000000000000bb', c: 1 },
    ];
    if (sql.includes('FROM processed_x402_payments')) return [{ c: 7 }]; // payment count (secondary)
    return [];
  });
  it('paid stage = DISTINCT paying WALLETS (not payments); payments secondary; repeat-payers', async () => {
    const a = await getAgentFunnel('all', deps);
    expect(a.stages.map(s => s.count)).toEqual([1000, 800, 10, 3]); // paid = 3 distinct wallets, NOT 7 payments
    expect(a.stages[3].sublabel).toContain('distinct paying wallets');
    expect(a.paid_detail).toMatchObject({ distinct_wallets: 3, payments: 7 });
    expect(a.paid_detail.repeat_payers).toEqual([{ wallet: '0xreal…00aa', calls: 4 }, { wallet: '0xreal…00bb', calls: 1 }]);
    expect(a.paid_note).toContain('Distinct paying WALLETS');
    expect(a.quota_detail).toEqual({ windowed_hard_block: 10, soft_approaching: 20, all_time_pqls: 10 });
    expect(a.transitions[0].rate).toBeCloseTo(0.8); // conn→activated
    // AC4 (internal-only): the funnel NEVER emits a FULL wallet address — operator display is truncated.
    expect(JSON.stringify(a)).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});

describe('getHoldUpside', () => {
  const seen: string[] = [];
  const deps = funnelDeps((sql) => {
    seen.push(sql);
    if (sql.includes("verdict = 'HOLD'")) return [{ c: 990 }];
    if (sql.includes("verdict IN ('BUY','SELL')")) return [{ c: 9 }];
    if (sql.includes('verdict IS NULL')) return [{ c: 1 }];
    if (sql.includes('FROM request_log')) return [{ c: 1000 }]; // external total
    if (sql.includes('FROM agent_sessions')) return [{ c: 800 }]; // active agents
    return [];
  });
  it('external-only math: avg/agent, hold_rate, labeled upside', async () => {
    const u = await getHoldUpside('all', deps);
    expect(u.external_calls).toBe(1000);
    expect(u.hold_calls).toBe(990);
    expect(u.trade_calls).toBe(9);
    expect(u.non_verdict_calls).toBe(1);
    expect(u.avg_calls_per_active_agent).toBeCloseTo(1.25); // 1000/800
    expect(u.hold_rate).toBeCloseTo(0.991); // 990/999
    expect(u.upside).toEqual([{ price: 0.001, amount: 0.99 }, { price: 0.002, amount: 1.98 }, { price: 0.005, amount: 4.95 }]);
  });
  it('every request_log read is is_bot_internal=false (internal excluded, AC4)', () => {
    const rl = seen.filter(s => s.includes('FROM request_log'));
    expect(rl.length).toBeGreaterThan(0);
    expect(rl.every(s => s.includes('is_bot_internal = false'))).toBe(true);
  });
});

describe('projectClientActivity (mirrors the Telegram digest, single-derivation)', () => {
  const usage = {
    totalCallsExternal: { last24h: 707 },
    externalGenuine: { free: 12, paid: 0, freeSessions: 10, paidSessions: 0 },
    externalAutomated: { total: 641, sessions: 50 },
    rawConcentration: { top1_pct: 10.3 },
    uniqueSessionsExternal: { last24h: 81 },
    tgBot: { present: true, stale: false, calls_total: 54, calls_watch: 16, calls_scanwatch: 38, calls_scan: 0, subscribers: 21 },
  };
  it('projects the exact digest buckets (calls + sessions)', () => {
    const ca = projectClientActivity(usage);
    expect(ca.calls).toEqual({
      total: 707, recognized: 12, raw_api: 641, raw_api_top1_pct: 10.3, paid: 0,
      // OPS-DIGEST-PAID-RAIL-SPLIT-W1: null (not 0) — this legacy fixture carries no rail
      // split, mirroring a /analytics payload from before the split shipped.
      paid_subscription: null, paid_x402: null,
      tg_bot: 54, tg_bot_breakdown: { watch: 16, scanwatch: 38, scan: 0 },
    });
    expect(ca.sessions).toEqual({
      total: 81, recognized: 10, raw_api: 50, paid: 0,
      paid_subscription: null, paid_x402: null, tg_bot_subscribers: 21,
    });
  });
  // OPS-DIGEST-PAID-RAIL-SPLIT-W1
  it('projects the per-rail paid split when /analytics supplies it', () => {
    const ca = projectClientActivity({
      ...usage,
      externalGenuine: {
        free: 340, paid: 162, freeSessions: 43, paidSessions: 47,
        paidSubscription: 162, paidX402: 0,
        paidSubscriptionSessions: 47, paidX402Sessions: 0,
      },
    });
    expect(ca.calls.paid).toBe(162);
    expect(ca.calls.paid_subscription).toBe(162);
    expect(ca.calls.paid_x402).toBe(0);
    expect(ca.sessions.paid_subscription).toBe(47);
    expect(ca.sessions.paid_x402).toBe(0);
  });
  it('preserves the top-IP percent as a float (not truncated)', () => {
    expect(projectClientActivity(usage).calls.raw_api_top1_pct).toBe(10.3);
  });
  it('null/empty usage → all-null, tg fields null (fail-open, never 0)', () => {
    const ca = projectClientActivity(null);
    expect(ca.calls.total).toBeNull();
    expect(ca.calls.tg_bot).toBeNull();
    expect(ca.sessions.tg_bot_subscribers).toBeNull();
  });
});

// ── Orchestrator (injected deps → known metrics) ───────────────────────────────

function stubSnapshot(): FunnelSnapshot {
  return {
    generated_at: new Date(NOW).toISOString(),
    window: { from: new Date(NOW - 90 * DAY).toISOString(), to: new Date(NOW).toISOString() },
    sessions: { total: 7183, unique_ips: null, new_in_window: null },
    funnel: {
      install: null, first_call: null, second_call: null, fifth_plus_call: null,
      first_non_hold_verdict: 57, track_record_viewed: 70, landing_cta_clicked: 85, paid_upgrade: null,
      mcp_tools_list: 1553, quota_hit_soft: 86, quota_hit_hard: 64, quota_hit_block: 28,
      upgrade_cta_clicked: 1, stripe_checkout_started: null, tg_bot_start: null,
      tg_bot_first_command: null, tg_bot_watchlist_add: null, tg_bot_quota_hit: null, tg_bot_upgrade_clicked: null,
    },
    conversion: { install_to_first_call: null, first_to_second: null, second_to_fifth: null, fifth_to_paid: null },
    stage_retentions: {}, weakest_stage_transition: null, stick_rate: null,
    time_to_first_call_ms: { p50: null, p90: null },
    tool_call_distribution: { get_trade_signal: 0, get_market_regime: 0, scan_funding_arb: 0, other: 0 },
    hold_rate_get_trade_signal: null,
    tier_cohort_sizes: { free: 8, starter: 1, pro: 0, enterprise: 0, x402: 1 },
    by_source: null,
    identity_coverage: { identified: 2, fallback: 3, anonymous: 5, coverage_pct: 0.2 },
    by_authenticity: null,
    warnings: [],
  };
}

function makeDeps(overrides: Partial<ScoreboardDeps> = {}): ScoreboardDeps {
  const signupRows = [
    { created_at: new Date(NOW).toISOString(), channel: 'direct' },
    { created_at: new Date(NOW).toISOString(), channel: 'direct' },
    { created_at: new Date(NOW).toISOString(), channel: 'tg_bot' },
    { created_at: new Date(NOW - 7 * DAY).toISOString(), channel: 'direct' },
  ]; // total 4: direct 3, tg_bot 1
  const agentSessions = [
    { session_id: 's1', first_seen: NOW - 40 * DAY, last_seen: NOW - 5 * DAY, first_tier: 'free', tiers_seen: 'free' }, // free, retained
    { session_id: 's2', first_seen: NOW - 40 * DAY, last_seen: NOW - 39 * DAY, first_tier: 'free', tiers_seen: 'free' }, // free, not retained
    { session_id: 's3', first_seen: NOW - 3 * DAY, last_seen: NOW - 3 * DAY, first_tier: 'free', tiers_seen: 'free' }, // free, too young
    { session_id: 's4', first_seen: NOW - 40 * DAY, last_seen: NOW - 2 * DAY, first_tier: 'pro', tiers_seen: 'free,pro' }, // paid, retained
    { session_id: 's5', first_seen: NOW - 40 * DAY, last_seen: NOW - 1 * DAY, first_tier: 'internal', tiers_seen: 'internal' }, // internal → excluded
  ];
  const connectSrcRows = [
    { session_id: 's1', meta_json: JSON.stringify({ src: 'claude' }) },
    { session_id: 's2', meta_json: JSON.stringify({ src: 'claude' }) },
    { session_id: 's4', meta_json: JSON.stringify({ source: 'unknown' }) },
  ]; // s3 → untagged; s5 excluded (internal)
  const query = async <T>(sql: string): Promise<T[]> => {
    if (sql.includes('GROUP BY payer_wallet')) return [] as unknown as T[];
    if (sql.includes('processed_x402_payments')) return [{ c: 7 }] as unknown as T[];
    if (sql.includes('COUNT(DISTINCT session_id)') && sql.includes("'mcp_connect'")) return [{ c: 7183 }] as unknown as T[];
    if (sql.includes('session_id, meta_json') && sql.includes("'mcp_connect'")) return connectSrcRows as unknown as T[];
    if (sql.includes('FROM signup_attribution')) return signupRows as unknown as T[];
    if (sql.includes('FROM free_keys')) return [{ c: 6 }] as unknown as T[];
    if (sql.includes('FROM signup_emails')) return [{ c: 0 }] as unknown as T[];
    if (sql.includes('FROM agent_sessions')) return agentSessions as unknown as T[];
    return [] as T[];
  };
  return {
    snapshot: async () => stubSnapshot(),
    stripeCensus: async () => ({ starter: 1, pro: 0, enterprise: 0, total: 1, source: 'stripe_live', as_of: NOW }),
    listProfiles: async () => [
      { customer_id: 'c1', status: 'active', tier: 'starter', channel: 'direct',
        converted_at: new Date(NOW - 32 * DAY).toISOString(), attribution_captured: false } as never,
    ],
    usageStats: async () => ({
      totalCallsExternal: { last24h: 707 },
      externalGenuine: { free: 12, paid: 0, freeSessions: 10, paidSessions: 0 },
      externalAutomated: { total: 641, sessions: 50 },
      rawConcentration: { top1_pct: 10.3 },
      uniqueSessionsExternal: { last24h: 81 },
      tgBot: { present: true, stale: false, calls_total: 54, calls_watch: 16, calls_scanwatch: 38, calls_scan: 0, subscribers: 21 },
    }),
    query,
    now: () => NOW,
    ...overrides,
  };
}

describe('getFunnelScoreboard (composed, injected deps)', () => {
  it('renders the 4 numbers + intent panel from a known fixture', async () => {
    const sb = await getFunnelScoreboard({ days: 90 }, makeDeps());

    // Metric 1 — paying subscribers (Stripe-live canonical) + x402 SEPARATE line
    expect(sb.paying_subscribers.headline_source).toBe('stripe_live');
    expect(sb.paying_subscribers.total).toBe(1);
    expect(sb.paying_subscribers.by_tier).toEqual({ starter: 1, pro: 0, enterprise: 0 });
    expect(sb.paying_subscribers.x402_separate.payments_in_window).toBe(7);
    expect(sb.paying_subscribers.reconciliation.instrumentation_artifact).toBe(false);

    // Metric 2 — micro-funnel Reach → Intent → Accounts (never collapsed)
    expect(sb.free_signups.reach_mcp_connect_all_time).toBe(7183);
    expect(sb.free_signups.signup_intent.total_all_time).toBe(4);
    expect(sb.free_signups.signup_intent.by_channel).toEqual({ direct: 3, tg_bot: 1 });
    expect(sb.free_signups.free_accounts).toBe(6); // free_keys 6 + signup_emails 0
    expect(sb.free_signups.awareness_activation_collapse).toEqual({ reach: 7183, intent: 4, accounts: 6 });

    // Metric 3 — conversion at BOTH denominators + unattributable front-and-center
    expect(sb.conversion.paid_over_free_accounts).toBeCloseTo(1 / 6);
    expect(sb.conversion.paid_over_signup_intent).toBeCloseTo(1 / 4);
    expect(sb.conversion.unattributable_pct).toBe(1); // the 1 conversion is attribution_captured=false

    // Metric 4 — retention breakdown: internal bot excluded, free vs paid, by channel
    expect(sb.retention.overall.d7).toBeCloseTo(2 / 3); // s1,s2,s4 eligible; s1,s4 retained
    expect(sb.retention.overall.d90).toBeNull();
    expect(sb.retention.overall.d90_matures_on).toBe('2026-08-28');
    expect(sb.retention.by_tier.free.d7).toBeCloseTo(0.5); // s1,s2 eligible; s1 retained
    expect(sb.retention.by_tier.paid.d7).toBeCloseTo(1); // s4 eligible + retained
    expect(sb.retention.internal_excluded).toBe(1); // s5 (internal) removed from every curve
    expect(sb.retention.by_channel[0].channel).toBe('claude'); // sorted by cohort desc
    const claude = sb.retention.by_channel.find(c => c.channel === 'claude');
    expect(claude?.curve.cohort_size).toBe(2);
    expect(claude?.curve.d7).toBeCloseTo(0.5);

    // Intent panel
    expect(sb.intent_panel.upgrade_cta_clicked).toBe(1);
    expect(sb.intent_panel.landing_cta_clicked).toBe(85);
    expect(sb.intent_panel.quota_hits).toEqual({ soft: 86, hard: 64, block: 28 });
    expect(sb.intent_panel.tagged_vs_direct).toEqual({ tagged: 1, direct: 3, direct_pct: 3 / 4 });
    expect(sb.intent_panel.identity_coverage.coverage_pct).toBe(0.2);

    // Client-type split (24h) — mirrors the Telegram digest number-for-number
    expect(sb.client_activity_24h.calls.total).toBe(707);
    expect(sb.client_activity_24h.calls.raw_api).toBe(641);
    expect(sb.client_activity_24h.calls.raw_api_top1_pct).toBe(10.3);
    expect(sb.client_activity_24h.calls.tg_bot).toBe(54);
    expect(sb.client_activity_24h.sessions.total).toBe(81);
    expect(sb.client_activity_24h.sessions.tg_bot_subscribers).toBe(21);

    // daily timeseries present
    expect(sb.daily.length).toBeGreaterThan(0);
    expect(sb.warnings).toEqual([]);
  });

  it('default-deny: a broken free_keys read → free_accounts null, not a favorable number', async () => {
    const deps = makeDeps({
      query: async <T>(sql: string): Promise<T[]> => {
        if (sql.includes('FROM free_keys')) throw new Error('relation "free_keys" does not exist');
        if (sql.includes('FROM signup_emails')) throw new Error('boom');
        if (sql.includes('GROUP BY payer_wallet')) return [] as unknown as T[];
    if (sql.includes('processed_x402_payments')) return [{ c: 7 }] as unknown as T[];
        if (sql.includes("event_type = 'mcp_connect'")) return [{ c: 7183 }] as unknown as T[];
        if (sql.includes('FROM signup_attribution')) return [] as T[];
        if (sql.includes('FROM agent_sessions')) return [] as T[];
        return [] as T[];
      },
    });
    const sb = await getFunnelScoreboard({ days: 90 }, deps);
    expect(sb.free_signups.free_accounts).toBeNull(); // both reads failed → null, not 0
    expect(sb.conversion.paid_over_free_accounts).toBeNull(); // default-deny propagates
    expect(sb.warnings.some(w => w.startsWith('free_keys'))).toBe(true);
  });

  it('falls back to subscriber_profiles when Stripe is unavailable', async () => {
    const deps = makeDeps({ stripeCensus: async () => null });
    const sb = await getFunnelScoreboard({}, deps);
    expect(sb.paying_subscribers.headline_source).toBe('subscriber_profiles_fallback');
    expect(sb.paying_subscribers.total).toBe(1); // 1 active profile
    expect(sb.data_freshness.stripe_source).toBe('unavailable');
  });
});

// ── OPS-STRIPE-SUBSCRIPTION-TRUTH-W2 · CH2 (AC 2.6) ─────────────────────────────────────────
//
// CH2 makes a cancellation flip `subscriber_profiles.status` off 'active' for the first time —
// so for the first time a non-active row can EXIST. Every active-count derivation must exclude
// it, or the wave that stopped MRR under-reporting starts it over-reporting instead.
//
// This exercises the SHIPPED predicate through the composed scoreboard (not a re-implementation
// of the filter, which would agree with itself). The two totals are deliberately compared:
// `reconciliation.profiles_total` counts ACTIVE rows, `enrichment.profiles_total` counts ALL of
// them — if the filter were dropped, the first would silently become the second.
describe('active-count derivations exclude a cancelled profile (CH2)', () => {
  const twoProfiles = async () => ([
    { customer_id: 'c_live', status: 'active', tier: 'pro', channel: 'direct',
      converted_at: new Date(NOW - 32 * DAY).toISOString(), attribution_captured: false },
    { customer_id: 'c_gone', status: 'canceled', tier: 'pro', channel: 'direct',
      converted_at: new Date(NOW - 40 * DAY).toISOString(), attribution_captured: false },
  ] as never);

  it('a canceled row does NOT contribute to the reconciliation active count', async () => {
    const sb = await getFunnelScoreboard({ days: 90 }, makeDeps({ listProfiles: twoProfiles }));
    expect(sb.paying_subscribers.reconciliation.profiles_total).toBe(1);
    // ...while the enrichment total still sees both, so the exclusion is real and not just a
    // smaller fixture. If the active filter were removed, this pair would collapse to 2 and 2.
    expect(sb.paying_subscribers.enrichment.profiles_total).toBe(2);
  });

  it('status matching is case-insensitive but strict — ACTIVE counts, past_due does not', async () => {
    const mixed = async () => ([
      { customer_id: 'c1', status: 'ACTIVE', tier: 'pro', channel: 'direct',
        converted_at: new Date(NOW - 5 * DAY).toISOString(), attribution_captured: false },
      { customer_id: 'c2', status: 'past_due', tier: 'pro', channel: 'direct',
        converted_at: new Date(NOW - 5 * DAY).toISOString(), attribution_captured: false },
      { customer_id: 'c3', status: null, tier: 'pro', channel: 'direct',
        converted_at: new Date(NOW - 5 * DAY).toISOString(), attribution_captured: false },
    ] as never);
    const sb = await getFunnelScoreboard({ days: 90 }, makeDeps({ listProfiles: mixed }));
    expect(sb.paying_subscribers.reconciliation.profiles_total).toBe(1);
    expect(sb.paying_subscribers.enrichment.profiles_total).toBe(3);
  });
});

// ── OPS-STRIPE-SUBSCRIPTION-TRUTH-W3 · CH1 ──────────────────────────────────────────────────
//
// The old `divergent` rule was `absGap > 0 && (ratioDivergent || absGap > 10)`. At n=4 a WHOLE
// MISSING PAYING CUSTOMER gives absGap=1 — neither >10 nor 4/3>2 — so the guard could not fire
// at any discrepancy this product can currently have. A threshold calibrated for a large base is
// not a conservative guard on a small one; it is no guard at all.
//
// The fix separates two questions the one flag was answering at once:
//   divergent               = do the two sides disagree?      (any gap or cell mismatch, any n)
//   instrumentation_artifact = is the gap absurdly large?      (the >2x / >10 rule, UNCHANGED)
// Noise control moved to revenue-meter-canary.py, which requires SUSTAINED breach.

const cell = (tier: string, interval: string, count: number) => ({ tier, interval, count });

describe('reconcileCounts — composition awareness (CH1)', () => {
  // TODAY'S LIVE DEFECT, pre-backfill: Stripe bills 3 starter + 1 pro (all monthly); the record
  // says 4 starter with no cadence at all. Totals agree at 4-vs-4, which is precisely why a
  // totals-only check reported clean while $39.01/mo of MRR was invisible.
  const STRIPE_LIVE = [cell('starter', 'month', 3), cell('pro', 'month', 1)];
  const PROFILES_PRE = [cell('starter', 'unknown', 4)];
  const PROFILES_POST = [cell('starter', 'month', 3), cell('pro', 'month', 1)];

  it('1.1 reports DIVERGENT on the live mismatch, even though the TOTALS agree', () => {
    const r = reconcileCounts(4, 4, STRIPE_LIVE, PROFILES_PRE);
    expect(r.divergent).toBe(true);
    expect(r.stripe_total).toBe(4);
    expect(r.profiles_total).toBe(4);           // totals identical — the old check saw only this
    expect(r.composition_compared).toBe(true);
    // Three disagreeing cells: pro/month absent from the record, starter/month absent, and a
    // starter/unknown bucket that exists nowhere in Stripe.
    expect(r.composition_mismatches).toEqual([
      { tier: 'pro', interval: 'month', stripe: 1, profiles: 0 },
      { tier: 'starter', interval: 'month', stripe: 3, profiles: 0 },
      { tier: 'starter', interval: 'unknown', stripe: 0, profiles: 4 },
    ]);
  });

  it('1.1b goes CLEAN once the record matches — the guard proven in BOTH directions', () => {
    const r = reconcileCounts(4, 4, STRIPE_LIVE, PROFILES_POST);
    expect(r.divergent).toBe(false);
    expect(r.composition_compared).toBe(true);
    expect(r.composition_mismatches).toEqual([]);
  });

  it('1.2 a ONE-customer gap is divergent at n=4 — the old threshold could not fire', () => {
    // absGap=1: not >10, and 4/3 is not >2. Under the old rule this was divergent:false, which
    // the canary's own docblock had already recorded happening over a real missing customer.
    const r = reconcileCounts(4, 3);
    expect(r.divergent).toBe(true);
    expect(r.instrumentation_artifact).toBe(false); // real drift, not an instrumentation bug
  });

  it('1.3 small-n and large-n: "they disagree" has no scale; "absurd" does', () => {
    const smallN = reconcileCounts(4, 3);
    const largeN = reconcileCounts(500, 499);
    const absurd = reconcileCounts(500, 1);
    // Both report the disagreement...
    expect(smallN.divergent).toBe(true);
    expect(largeN.divergent).toBe(true);
    // ...neither is an instrumentation artifact...
    expect(smallN.instrumentation_artifact).toBe(false);
    expect(largeN.instrumentation_artifact).toBe(false);
    // ...while a 500-vs-1 gap is both, and that rule is UNCHANGED from before this wave.
    expect(absurd.divergent).toBe(true);
    expect(absurd.instrumentation_artifact).toBe(true);
  });

  it('distinguishes "the tiers agree" from "nobody compared them"', () => {
    // An empty mismatch list alone cannot express the difference — hence composition_compared.
    const notCompared = reconcileCounts(4, 4);
    expect(notCompared.composition_compared).toBe(false);
    expect(notCompared.composition_mismatches).toEqual([]);
    expect(notCompared.divergent).toBe(false);

    const compared = reconcileCounts(4, 4, STRIPE_LIVE, PROFILES_POST);
    expect(compared.composition_compared).toBe(true);
  });

  it('walks the UNION — a cell present on only ONE side is the likeliest real defect', () => {
    const r = reconcileCounts(2, 2, [cell('starter', 'month', 2)], [cell('pro', 'year', 2)]);
    expect(r.divergent).toBe(true);
    expect(r.composition_mismatches).toHaveLength(2); // an intersection-only walk would find 0
  });

  it('a Stripe outage is SILENCE, not agreement — contract unchanged', () => {
    const r = reconcileCounts(null, 4, undefined, PROFILES_PRE);
    expect(r.divergent).toBe(false);
    expect(r.composition_compared).toBe(false);
  });
});

describe('profilesComposition — folds rows the same way both sides are counted', () => {
  it('groups by tier x billing_interval', () => {
    expect(profilesComposition([
      { tier: 'starter', billing_interval: 'month' },
      { tier: 'starter', billing_interval: 'month' },
      { tier: 'pro', billing_interval: 'year' },
    ])).toEqual([
      { tier: 'pro', interval: 'year', count: 1 },
      { tier: 'starter', interval: 'month', count: 2 },
    ]);
  });

  it('a NULL tier or cadence folds to `unknown`, never silently dropped', () => {
    // Dropping them would make the record look like it agreed by having fewer rows to disagree.
    expect(profilesComposition([{ tier: null, billing_interval: null }])).toEqual([
      { tier: 'unknown', interval: 'unknown', count: 1 },
    ]);
  });

  it('is empty for no rows — a fact, not a failure', () => {
    expect(profilesComposition([])).toEqual([]);
  });
});

// ── OPS-QUOTA-FUNNEL-WALL-SPLIT-W1 — the per-cell guard ───────────────────────────────────
//
// The failure this exists to prevent is NOT "no guard". It is a guard that is technically
// present, evaluated on the POOLED number, and therefore passing while the cells it is meant to
// protect are far too thin to read. The pooled figure clears the floor, the panel looks checked,
// and a rate computed on n=3 is rendered as fact.
describe('agent_funnel.quota_wall_split — n<30 applies PER CELL, not to the pooled stage', () => {
  const D = '{"used":40,"total":40,"limit":"daily"}';
  const M = '{"used":200,"total":200,"limit":"monthly"}';
  const U = '{"used":1,"total":2}'; // pre-cutover: no discriminator at all

  /** Build `n` block rows on one wall, each from its own session. */
  function walled(prefix: string, n: number, meta: string, eventType = 'quota_hit_block') {
    return Array.from({ length: n }, (_, i) => ({
      event_type: eventType,
      session_id: `${prefix}${i}`,
      meta_json: meta,
    }));
  }

  /**
   * Router for the wall-split queries. `cutover` is the ALL-TIME bounds row; leaving
   * `absent_until` null means the window is post-cutover, so maturity never masks the n<30
   * assertion we are actually making.
   */
  function wallDeps(
    rows: Array<{ event_type: string; session_id: string; meta_json: string }>,
    opts: { pooled: number; activated: number; absentUntil?: string | null } = { pooled: 31, activated: 800 },
  ) {
    return funnelDeps((sql) => {
      if (sql.includes('meta_json') && sql.includes('session_id') && sql.includes('event_type IN')) return rows;
      if (sql.includes('absent_until')) return [
        { event_type: 'quota_hit_block', live_since: '2026-08-09T08:35:52.505Z', absent_until: opts.absentUntil ?? null },
        { event_type: 'quota_hit_hard', live_since: '2026-08-15T22:39:54.582Z', absent_until: opts.absentUntil ?? null },
        { event_type: 'quota_hit_soft', live_since: '2026-08-15T21:39:50.063Z', absent_until: opts.absentUntil ?? null },
      ];
      if (sql.includes("'mcp_connect'")) return [{ c: 1000 }];
      if (sql.includes('FROM agent_sessions')) return [{ c: opts.activated }];
      if (sql.includes("'quota_hit_hard','quota_hit_block'")) return [{ c: opts.pooled }];
      if (sql.includes("'quota_hit_soft'")) return [{ c: 20 }];
      if (sql.includes('FROM quota_usage')) return [{ c: 10 }];
      if (sql.includes('COUNT(DISTINCT')) return [{ c: 3 }];
      if (sql.includes('FROM processed_x402_payments')) return [{ c: 7 }];
      return [];
    });
  }

  it('🎯 pooled n=31 CLEARS the floor while every split cell is suppressed', async () => {
    // The live 30-day shape measured 2026-08-22: pooled 31, cells daily 14 / monthly 7 /
    // unknown 21. A guard on the pooled number alone reports GREEN on all three.
    const a = await getAgentFunnel('30', wallDeps([
      ...walled('d', 14, D),
      ...walled('m', 7, M),
      ...walled('u', 21, U),
    ]));
    const s = a.quota_wall_split!;
    expect(s.pooled_sessions).toBe(31);
    expect(s.pooled_low_confidence).toBe(false); // the pooled figure PASSES — that is the trap

    const cell = (b: string) => s.cells.find(c => c.bucket === b)!;
    expect(cell('daily').sessions).toBe(14);
    expect(cell('monthly').sessions).toBe(7);
    expect(cell('unknown').sessions).toBe(21);

    // …and every cell is suppressed anyway, because the guard is evaluated per cell.
    for (const b of ['daily', 'monthly', 'unknown']) {
      expect(cell(b).activated_to_wall).toBeNull();
      expect(cell(b).suppressed_reason).not.toBeNull();
    }
    expect(cell('daily').low_confidence).toBe(true);
    expect(cell('daily').suppressed_reason).toContain('n=14');
    expect(cell('monthly').suppressed_reason).toContain('n=7');
    // `unknown` is refused a rate on principle, not merely on sample size.
    expect(cell('unknown').suppressed_reason).toContain('not a wall');
  });

  it('🎯 a thin cell is suppressed even when the pooled figure is enormous', async () => {
    // The spec's exact scenario: a daily cell at n=3 hiding behind a pooled figure that clears
    // 30 comfortably. Nothing about the pooled number may rescue the cell.
    const a = await getAgentFunnel('30', wallDeps(
      [...walled('d', 3, D), ...walled('m', 500, M)],
      { pooled: 503, activated: 4000 },
    ));
    const s = a.quota_wall_split!;
    expect(s.pooled_low_confidence).toBe(false);
    const daily = s.cells.find(c => c.bucket === 'daily')!;
    const monthly = s.cells.find(c => c.bucket === 'monthly')!;
    expect(daily.sessions).toBe(3);
    expect(daily.low_confidence).toBe(true);
    expect(daily.activated_to_wall).toBeNull();
    expect(daily.suppressed_reason).toContain('n=3');
    // The healthy cell still reports — suppression is per cell, not all-or-nothing.
    expect(monthly.low_confidence).toBe(false);
    expect(monthly.activated_to_wall).toBeCloseTo(500 / 4000, 10);
  });

  it('🎯 the wall MIX excludes unknown from both sides and is guarded on its own n', async () => {
    const a = await getAgentFunnel('30', wallDeps(
      [...walled('d', 30, D), ...walled('m', 10, M), ...walled('u', 5000, U)],
      { pooled: 5040, activated: 9000 },
    ));
    const mix = a.quota_wall_split!.mix;
    expect(mix.denominator).toBe(40); // 30 + 10 — the 5000 unknown are NOT in here
    expect(mix.excluded_unknown).toBe(5000);
    expect(mix.suppressed_reason).toBeNull();
    expect(mix.daily_pct).toBeCloseTo(0.75, 10);
    expect(mix.monthly_pct).toBeCloseTo(0.25, 10);
    expect(mix.denominator_note).toContain('excluded from BOTH');
  });

  it('🎯 a window that still contains pre-cutover rows suppresses the rate rather than diluting it', async () => {
    // Cohort maturity: the window opens BEFORE the discriminator existed, so a rate over it is
    // diluted by rows that could never have carried a wall.
    const a = await getAgentFunnel('30', wallDeps(
      [...walled('d', 60, D), ...walled('m', 60, M)],
      { pooled: 120, activated: 800, absentUntil: '2099-01-01T00:00:00.000Z' },
    ));
    const s = a.quota_wall_split!;
    expect(s.stages.every(st => st.window_predates_cutover)).toBe(true);
    const daily = s.cells.find(c => c.bucket === 'daily')!;
    expect(daily.low_confidence).toBe(false); // n=60 is plenty…
    expect(daily.activated_to_wall).toBeNull(); // …and it is STILL suppressed
    expect(daily.suppressed_reason).toContain('before the discriminator cutover');
    expect(s.mix.daily_pct).toBeNull();
  });

  it('🎯 each stage carries its OWN cutover bounds — the three are never collapsed into one', async () => {
    const a = await getAgentFunnel('30', wallDeps([...walled('d', 5, D)]));
    const byStage = Object.fromEntries(
      a.quota_wall_split!.stages.map(s => [s.event_type, s.discriminator_cutover.live_since]),
    );
    expect(byStage.quota_hit_block).toBe('2026-08-09T08:35:52.505Z');
    expect(byStage.quota_hit_soft).toBe('2026-08-15T21:39:50.063Z');
    expect(byStage.quota_hit_hard).toBe('2026-08-15T22:39:54.582Z');
    expect(new Set(Object.values(byStage)).size).toBe(3); // three instants, not one
  });

  it('🎯 the two underivable questions render as PENDING with their blockers named', async () => {
    const a = await getAgentFunnel('30', wallDeps([...walled('d', 5, D)]));
    const pending = a.quota_wall_split!.pending;
    const ids = pending.map(p => p.id);
    expect(ids).toContain('keyed_vs_keyless');
    expect(ids).toContain('wall_to_paid');
    // An operator must be able to tell a missing stage from a zero one, so every pending row
    // names WHY it cannot be derived and what was measured.
    for (const p of pending) {
      expect(p.question.length).toBeGreaterThan(0);
      expect(p.blocker.length).toBeGreaterThan(0);
      expect(p.evidence.length).toBeGreaterThan(0);
    }
    expect(pending.find(p => p.id === 'keyed_vs_keyless')!.blocker).toContain('av_free_');
    expect(pending.find(p => p.id === 'wall_to_paid')!.blocker).toContain('session_id');
  });

  it('🎯 cells do not sum to the pooled stage when a session hits both walls, and that is stated', async () => {
    const a = await getAgentFunnel('30', wallDeps(
      [
        { event_type: 'quota_hit_block', session_id: 'both', meta_json: D },
        { event_type: 'quota_hit_block', session_id: 'both', meta_json: M },
        ...walled('m', 40, M),
      ],
      { pooled: 41, activated: 800 },
    ));
    const s = a.quota_wall_split!;
    expect(s.multi_bucket_sessions).toBe(1);
    expect(s.unit_note).toContain('do NOT sum');
    const sum = s.cells.reduce((n, c) => n + c.sessions, 0);
    expect(sum).toBeGreaterThan(s.pooled_sessions!); // 42 > 41 — the overlap, rendered not hidden
  });

  it('🎯 additive only — no existing agent-funnel number moves', async () => {
    // AC7. The split is a new sibling key; stages, transitions, quota_detail and paid_detail must
    // be identical to what the panel showed before it existed.
    const a = await getAgentFunnel('all', wallDeps([...walled('d', 9, D), ...walled('m', 5, M)], { pooled: 10, activated: 800 }));
    expect(a.stages.map(s => s.count)).toEqual([1000, 800, 10, 3]);
    expect(a.quota_detail).toEqual({ windowed_hard_block: 10, soft_approaching: 20, all_time_pqls: 10 });
    expect(a.paid_detail).toMatchObject({ distinct_wallets: 3, payments: 7 });
    expect(a.transitions[0].rate).toBeCloseTo(0.8);
    expect(JSON.stringify(a)).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(JSON.stringify(a)).not.toContain('outcome_return_pct');
  });

  it('🎯 a failed split query fails OPEN — null, never a throw on a serving path', async () => {
    const deps = funnelDeps((sql) => {
      if (sql.includes('meta_json') && sql.includes('event_type IN')) throw new Error('boom');
      if (sql.includes("'mcp_connect'")) return [{ c: 1000 }];
      if (sql.includes('FROM agent_sessions')) return [{ c: 800 }];
      if (sql.includes("'quota_hit_hard','quota_hit_block'")) return [{ c: 10 }];
      return [];
    });
    const a = await getAgentFunnel('30', deps);
    expect(a.quota_wall_split).toBeNull();
    expect(a.stages.map(s => s.count)[0]).toBe(1000); // the rest of the panel still renders
  });

  it('🎯 a producer emitting an UNRECOGNISED wall reports it instead of absorbing it', async () => {
    const a = await getAgentFunnel('30', wallDeps([
      ...walled('d', 5, D),
      { event_type: 'quota_hit_block', session_id: 'w1', meta_json: '{"limit":"weekly"}' },
    ]));
    const s = a.quota_wall_split!;
    // The unknown wall is NOT silently counted as monthly…
    expect(s.cells.find(c => c.bucket === 'monthly')!.sessions).toBe(0);
    expect(s.cells.find(c => c.bucket === 'unknown')!.sessions).toBe(1);
    // …and the divergence surfaces on the payload rather than dying in a discarded array.
    expect(s.warnings.join(' ')).toContain('disagreed on 1 row');
  });
});

// ── Bypassed-artifact assertions ──────────────────────────────────────────────────────────
//
// Two mutations initially SURVIVED this suite, and both survived for the same reason: the tests
// substituted the very artifact the mutation lived in. Pooling was asserted against a literal
// array rather than the shipped constant, and the cutover SQL was never executed because the
// router stubs its result. A hermetic test is structurally blind to exactly what its own seam
// replaces — so the bypassed artifacts are asserted directly here.
describe('quota wall split — the artifacts the stubs bypass', () => {
  it('🎯 the SHIPPED pooled constant is hard+block, and excludes the soft warning', () => {
    // `quota_hit_soft` is an "approaching" nudge, not a wall. Pooling it into the crossing would
    // inflate the stage with sessions that were never refused anything.
    expect([...POOLED_QUOTA_WALL_EVENT_TYPES]).toEqual(['quota_hit_hard', 'quota_hit_block']);
    expect(POOLED_QUOTA_WALL_EVENT_TYPES).not.toContain('quota_hit_soft');
    expect([...QUOTA_WALL_EVENT_TYPES]).toEqual(['quota_hit_soft', 'quota_hit_hard', 'quota_hit_block']);
    // Every pooled stage must be a declared stage, or it would be aggregated but never bucketed.
    for (const et of POOLED_QUOTA_WALL_EVENT_TYPES) expect(QUOTA_WALL_EVENT_TYPES).toContain(et);
  });

  it('🎯 pooling driven by the SHIPPED constant excludes soft sessions from the crossing', () => {
    // Uses POOLED_QUOTA_WALL_EVENT_TYPES itself, not a literal — so widening the constant to
    // include `quota_hit_soft` makes this test red instead of silently changing the panel.
    const agg = aggregateQuotaWallRows(
      [
        { event_type: 'quota_hit_block', session_id: 'walled', meta_json: '{"limit":"monthly"}' },
        { event_type: 'quota_hit_soft', session_id: 'merely-warned', meta_json: '{"limit":"daily"}' },
      ],
      QUOTA_WALL_EVENT_TYPES,
      POOLED_QUOTA_WALL_EVENT_TYPES,
    );
    expect(agg.pooled.distinct_sessions).toBe(1); // `merely-warned` was never refused
    expect(agg.pooled.sessions).toEqual({ daily: 0, monthly: 1, unknown: 0 });
    expect(agg.per_stage.quota_hit_soft.sessions.daily).toBe(1); // still reported per stage
  });

  it('🎯 the cutover SQL bounds BOTH sides on the discriminator predicate', async () => {
    // The router stubs this query's RESULT, so its text is the only part a test can reach — and
    // an `absent_until` that forgot the predicate would silently report the newest row of ALL
    // time as "the last row without a discriminator", collapsing every bound.
    const seen: string[] = [];
    const deps = funnelDeps((sql) => {
      seen.push(sql);
      return [];
    });
    await getAgentFunnel('30', deps);
    const boundsSql = seen.find(s => s.includes('absent_until'));
    expect(boundsSql).toBeDefined();
    expect(boundsSql).toContain(QUOTA_WALL_PRESENT_SQL);
    // MIN(...) = first row WITH the discriminator; MAX(...) = last row WITHOUT it. Both branches
    // must be predicated, and the MAX branch must invert (THEN NULL ELSE ts).
    expect(boundsSql).toMatch(new RegExp(`MIN\\(CASE WHEN ${QUOTA_WALL_PRESENT_SQL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} THEN ts END\\)`));
    expect(boundsSql).toMatch(new RegExp(`MAX\\(CASE WHEN ${QUOTA_WALL_PRESENT_SQL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} THEN NULL ELSE ts END\\)`));
    expect(boundsSql).toContain('GROUP BY event_type');
  });

  it('🎯 no backend-specific JSON SQL reaches either lane', async () => {
    // PG-only JSON operators break the SQLite lane. The split parses meta_json in JS precisely so
    // both backends run the same query text; this asserts none crept back in.
    const seen: string[] = [];
    await getAgentFunnel('30', funnelDeps((sql) => { seen.push(sql); return []; }));
    const wallSql = seen.filter(s => s.includes('meta_json') || s.includes('funnel_events'));
    expect(wallSql.length).toBeGreaterThan(0);
    for (const sql of wallSql) {
      expect(sql).not.toContain('->>');
      expect(sql).not.toContain('::jsonb');
      expect(sql).not.toContain('jsonb_');
      expect(sql).not.toContain('json_extract'); // the SQLite-only twin
      expect(sql).not.toContain('FILTER (WHERE'); // PG-only aggregate filter
    }
  });
});
