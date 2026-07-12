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
    if (sql.includes('SELECT channel FROM signup_attribution')) return [...Array(90).fill({ channel: 'direct' }), ...Array(10).fill({ channel: 'tg_bot' })];
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
    if (sql.includes('COUNT(DISTINCT lower(payer_wallet))')) return [{ c: 3 }];
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
      tg_bot: 54, tg_bot_breakdown: { watch: 16, scanwatch: 38, scan: 0 },
    });
    expect(ca.sessions).toEqual({ total: 81, recognized: 10, raw_api: 50, paid: 0, tg_bot_subscribers: 21 });
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
