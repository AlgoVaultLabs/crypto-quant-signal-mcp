/**
 * H0-C4-MEASURE-CLOSE — always-on activation-funnel scoreboard.
 *
 * The SINGLE exported aggregation every future funnel/awareness wave imports —
 * no more per-wave SQL. Turns the four milestone-gating numbers + a diagnostic
 * intent panel into one standing read: (1) paying subscribers by tier, (2)
 * free-user signups (the labeled Reach→Intent→Accounts micro-funnel), (3)
 * free→paid conversion, (4) retention curve (d7/d14/d30 live; d90 null until
 * the first cohort matures — never rendered as 0). Plus the intent panel
 * (upgrade/landing CTA, quota crossings, tagged-vs-direct traffic).
 *
 * MEASUREMENT-ONLY + MCP-TOOL-SURFACE FROZEN: reads only. Zero tool registration,
 * zero response-envelope, zero version bump. COMPOSES the existing standing infra
 * (generateFunnelSnapshot + subscriber-attribution aggregateProfiles/listSubscriberProfiles
 * + the Stripe price→tier census) rather than re-instrumenting — operator-ratified Q3.
 *
 * Dependency-injected (defaultScoreboardDeps) so the pure derivations are
 * fixture-unit-testable without a DB or Stripe (CLAUDE.md: business logic in an
 * exported module, the route handler a thin shell). Every DB read is fail-open
 * (default-deny to null + a warning — NEVER a silently-favorable number).
 *
 * Cross-backend note: all bucketing (weekly/daily) is done in JS over raw rows —
 * NO date_trunc/interval/::type (SQLite-incompatible; CLAUDE.md dual-backend rule).
 */
import { generateFunnelSnapshot, type FunnelSnapshot } from './funnel-snapshot.js';
import { dbQuery } from './performance-db.js';
import {
  listSubscriberProfiles,
  aggregateProfiles,
  type SubscriberProfileRow,
} from './subscriber-attribution.js';
import { countActiveSubscriptionsByTier, type ActiveSubscriberTierCensus } from './stripe.js';
import { getUsageStats } from './analytics.js';
import { mediumForSource, type AttributionSource } from './attribution-sources.js';
// OPS-X402-WALLET-ATTRIBUTION-W1: operator self-settle wallets are excluded from the distinct-
// paying-wallet CONVERSION metric (instrumentation_artifact); operator display is truncated.
import { operatorExclusionSql, truncateWallet } from './x402-operator-wallets.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_WINDOWS_DAYS = [7, 14, 30, 90] as const;

// ── Pure helpers (exported for unit tests — AC4) ──────────────────────────────

/** Coerce a DB timestamp (epoch number | JS Date [node-pg timestamptz] | ISO string) to epoch ms, or null. */
export function toEpochMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    // Pure epoch-ms strings (agent_sessions.first_seen) and ISO strings both parse.
    if (/^\d+$/.test(v.trim())) { const n = Number(v); return Number.isFinite(n) ? n : null; }
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** Strict non-negative int or null (default-deny: NaN / Infinity / non-numeric → null, never 0). */
export function safeCount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Math.trunc(Number(v));
  return null;
}

export interface RetentionCurve {
  d7: number | null;
  d14: number | null;
  d30: number | null;
  d90: number | null;
  /** ISO date the earliest observed cohort crosses 90d (when d90 is still null). */
  d90_matures_on: string | null;
  cohort_size: number | null;
}

/**
 * Return-retention curve over a set of sessions. For window N: a session is
 * ELIGIBLE if it is old enough to observe N days (now − first_seen ≥ N days);
 * RETAINED if it was still active ≥ N days after first appearing
 * (last_seen − first_seen ≥ N days). d_N = retained / eligible, or null when no
 * session is old enough (→ NEVER 0 for an immature window; AC4). d90_matures_on
 * is derived (earliest first_seen + 90d) so it is forward-stable, not hardcoded.
 */
export function computeRetentionCurve(
  sessions: Array<{ firstSeenMs: number; lastSeenMs: number }>,
  nowMs: number,
): RetentionCurve {
  const valid = sessions.filter(s => Number.isFinite(s.firstSeenMs) && Number.isFinite(s.lastSeenMs) && s.lastSeenMs >= s.firstSeenMs);
  const out: RetentionCurve = { d7: null, d14: null, d30: null, d90: null, d90_matures_on: null, cohort_size: valid.length || null };
  for (const n of RETENTION_WINDOWS_DAYS) {
    const horizon = n * DAY_MS;
    const eligible = valid.filter(s => nowMs - s.firstSeenMs >= horizon);
    if (eligible.length === 0) continue; // immature → leave null
    const retained = eligible.filter(s => s.lastSeenMs - s.firstSeenMs >= horizon).length;
    (out as unknown as Record<string, number | null>)[`d${n}`] = retained / eligible.length;
  }
  if (out.d90 === null && valid.length > 0) {
    const earliest = Math.min(...valid.map(s => s.firstSeenMs));
    out.d90_matures_on = new Date(earliest + 90 * DAY_MS).toISOString().slice(0, 10);
  }
  return out;
}

const PAID_TIERS = ['pro', 'starter', 'enterprise', 'x402'] as const;

/**
 * Bucket a session by tier for retention: `paid` (ever authenticated as any paid
 * tier), `internal` (the bot alert-engine's continuous polling — NOT a customer,
 * excluded from user retention), else `free`. Reads agent_sessions.first_tier +
 * tiers_seen. Pure.
 */
export function classifyTierBucket(firstTier: unknown, tiersSeen: unknown): 'free' | 'paid' | 'internal' {
  const first = typeof firstTier === 'string' ? firstTier.toLowerCase() : '';
  const seen = typeof tiersSeen === 'string' ? tiersSeen.toLowerCase() : '';
  if (PAID_TIERS.some(t => first === t || seen.includes(t))) return 'paid';
  if (first === 'internal' || seen.includes('internal')) return 'internal';
  return 'free';
}

export interface RetentionSession {
  firstSeenMs: number;
  lastSeenMs: number;
  tierBucket: 'free' | 'paid' | 'internal';
  channel: string; // connection-layer ?src= acquisition source (joins to session activity)
}

export interface RetentionBreakdown {
  /** Non-internal (free + paid) — the de-noised headline (excludes the bot alert-engine). */
  overall: RetentionCurve;
  by_tier: { free: RetentionCurve; paid: RetentionCurve };
  /** Per connection-source ?src= (NOT the /signup direct/tg_bot channel — that can't join to sessions). */
  by_channel: Array<{ channel: string; curve: RetentionCurve }>;
  /** Bot-alert-engine sessions removed from every curve above (they poll continuously → not a user signal). */
  internal_excluded: number;
  basis: string;
  coverage_caveat: string;
}

/**
 * Split the session return-retention curve three ways: overall (non-internal),
 * by tier (free vs paid), and by connection acquisition source. The pooled number
 * is dominated by the internal bot-alert-engine (continuous polling), so every
 * curve here EXCLUDES internal sessions — free/paid user retention is the real
 * signal. Pure. `channel` is the connection ?src= source (session-joinable), NOT
 * the /signup direct/tg_bot channel (which is a checkout-CTA click, not a session).
 */
export function computeRetentionBreakdown(sessions: RetentionSession[], nowMs: number): RetentionBreakdown {
  const nonInternal = sessions.filter(s => s.tierBucket !== 'internal');
  const free = nonInternal.filter(s => s.tierBucket === 'free');
  const paid = nonInternal.filter(s => s.tierBucket === 'paid');
  const byCh = new Map<string, RetentionSession[]>();
  for (const s of nonInternal) {
    const k = s.channel || 'untagged';
    const arr = byCh.get(k);
    if (arr) arr.push(s); else byCh.set(k, [s]);
  }
  const by_channel = [...byCh.entries()]
    .map(([channel, ss]) => ({ channel, curve: computeRetentionCurve(ss, nowMs) }))
    .sort((a, b) => (b.curve.cohort_size ?? 0) - (a.curve.cohort_size ?? 0));
  return {
    overall: computeRetentionCurve(nonInternal, nowMs),
    by_tier: { free: computeRetentionCurve(free, nowMs), paid: computeRetentionCurve(paid, nowMs) },
    by_channel,
    internal_excluded: sessions.length - nonInternal.length,
    basis: 'agent_sessions return-retention (retained at dN = last_seen − first_seen ≥ N days), split by tier (tiers_seen) + by connection acquisition source (mcp_connect ?src=); the bot alert-engine (internal) is excluded from every curve.',
    coverage_caveat: 'Channel here = the connection-layer ?src= source (the only channel that joins to session activity) — NOT the /signup direct/tg_bot channel (those are checkout-CTA clicks, and the TG bot polls as one internal identity). Cookieless: anon sessions get a fresh id per visit and read as non-retained.',
  };
}

/** Default-deny ratio: null unless both are finite numbers and denom > 0 (never 0-coerce a broken input). */
export function safeRatio(numer: number | null | undefined, denom: number | null | undefined): number | null {
  if (typeof numer !== 'number' || !Number.isFinite(numer)) return null;
  if (typeof denom !== 'number' || !Number.isFinite(denom) || denom <= 0) return null;
  return numer / denom;
}

export interface Reconciliation {
  stripe_total: number | null;
  profiles_total: number;
  divergent: boolean;
  /** CLAUDE.md: flag as instrumentation_artifact on >2× OR >10-absolute divergence. */
  instrumentation_artifact: boolean;
}

/** Cross-check the Stripe headline against the subscriber_profiles cache. */
export function reconcileCounts(stripeTotal: number | null, profilesTotal: number): Reconciliation {
  if (stripeTotal === null) {
    return { stripe_total: null, profiles_total: profilesTotal, divergent: false, instrumentation_artifact: false };
  }
  const absGap = Math.abs(stripeTotal - profilesTotal);
  const hi = Math.max(stripeTotal, profilesTotal);
  const lo = Math.min(stripeTotal, profilesTotal);
  const ratioDivergent = lo === 0 ? hi > 0 : hi / lo > 2;
  const artifact = absGap > 10 || (lo > 0 && hi / lo > 2);
  return {
    stripe_total: stripeTotal,
    profiles_total: profilesTotal,
    divergent: absGap > 0 && (ratioDivergent || absGap > 10),
    instrumentation_artifact: artifact,
  };
}

/** Bucket timestamped rows into daily counts (YYYY-MM-DD, UTC) over the last `days`. Pure. */
export function bucketDaily(
  tsList: Array<number | null>,
  nowMs: number,
  days: number,
): Array<{ date: string; count: number }> {
  const start = nowMs - days * DAY_MS;
  const byDay = new Map<string, number>();
  for (const ms of tsList) {
    if (ms === null || ms < start || ms > nowMs) continue;
    const day = new Date(ms).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const out: Array<{ date: string; count: number }> = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(nowMs - (days - 1 - d) * DAY_MS).toISOString().slice(0, 10);
    out.push({ date: day, count: byDay.get(day) ?? 0 });
  }
  return out;
}

/** Bucket rows into ISO-week counts by an optional channel key. Pure. Returns newest-first, capped. */
export function bucketWeeklyByChannel(
  rows: Array<{ ms: number | null; channel: string }>,
  maxWeeks = 12,
): Array<{ week: string; total: number; by_channel: Record<string, number> }> {
  const byWeek = new Map<string, { total: number; by_channel: Record<string, number> }>();
  for (const r of rows) {
    if (r.ms === null) continue;
    // Monday-anchored ISO-ish week key (UTC): shift to the week's Monday.
    const d = new Date(r.ms);
    const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
    const wk = monday.toISOString().slice(0, 10);
    const bucket = byWeek.get(wk) ?? { total: 0, by_channel: {} };
    bucket.total += 1;
    const ch = r.channel || 'unknown';
    bucket.by_channel[ch] = (bucket.by_channel[ch] ?? 0) + 1;
    byWeek.set(wk, bucket);
  }
  return [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, maxWeeks)
    .map(([week, v]) => ({ week, total: v.total, by_channel: v.by_channel }));
}

/** Walk a nested path in the loosely-typed getUsageStats() blob → integer or null. */
function nestedInt(obj: unknown, ...path: string[]): number | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return safeCount(cur);
}

/** Same walk but preserves a float (e.g. a percent like 10.3) instead of truncating. */
function nestedFloat(obj: unknown, ...path: string[]): number | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  if (typeof cur === 'number') return Number.isFinite(cur) ? cur : null;
  if (typeof cur === 'string' && cur.trim() !== '' && Number.isFinite(Number(cur))) return Number(cur);
  return null;
}

export interface ClientActivity24h {
  calls: {
    total: number | null;
    recognized: number | null;
    raw_api: number | null;
    raw_api_top1_pct: number | null; // percent (0-100), 1 decimal — top IP's share of the Raw-API bucket
    paid: number | null;
    tg_bot: number | null;
    tg_bot_breakdown: { watch: number | null; scanwatch: number | null; scan: number | null };
  };
  sessions: {
    total: number | null;
    recognized: number | null;
    raw_api: number | null;
    paid: number | null;
    tg_bot_subscribers: number | null;
  };
  note: string;
}

/**
 * Project the daily digest's client-TYPE split (🟢 Recognized · 🔌 Raw-API ·
 * 💳 Paid · 🔁 TG-bot, 24h) from the SAME `getUsageStats()` the Telegram digest
 * renders — SINGLE DERIVATION, so this panel matches the digest number-for-number
 * (same source, same 24h window). Pure. Distinct from the acquisition-source
 * channels in `free_signups` (which group by /signup origin, not client type).
 */
export function projectClientActivity(u: Record<string, unknown> | null): ClientActivity24h {
  const tg = (u && typeof u.tgBot === 'object' && u.tgBot !== null) ? (u.tgBot as Record<string, unknown>) : null;
  return {
    calls: {
      total: nestedInt(u, 'totalCallsExternal', 'last24h'),
      recognized: nestedInt(u, 'externalGenuine', 'free'),
      raw_api: nestedInt(u, 'externalAutomated', 'total'),
      raw_api_top1_pct: nestedFloat(u, 'rawConcentration', 'top1_pct'),
      paid: nestedInt(u, 'externalGenuine', 'paid'),
      tg_bot: tg ? safeCount(tg.calls_total) : null,
      tg_bot_breakdown: {
        watch: tg ? safeCount(tg.calls_watch) : null,
        scanwatch: tg ? safeCount(tg.calls_scanwatch) : null,
        scan: tg ? safeCount(tg.calls_scan) : null,
      },
    },
    sessions: {
      total: nestedInt(u, 'uniqueSessionsExternal', 'last24h'),
      recognized: nestedInt(u, 'externalGenuine', 'freeSessions'),
      raw_api: nestedInt(u, 'externalAutomated', 'sessions'),
      paid: nestedInt(u, 'externalGenuine', 'paidSessions'),
      tg_bot_subscribers: tg ? safeCount(tg.subscribers) : null,
    },
    note: 'Same source (getUsageStats) + 24h window as the Telegram daily digest — matches it number-for-number; client-TYPE split, distinct from the acquisition-source channels above',
  };
}

// ── FUNNEL-SCOREBOARD-V2: dual-funnel (human + agent) + HOLD upside ─────────────

export type FunnelWindow = '7' | '30' | '90' | '180' | '365' | 'all';
const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

/** Window key → days, or null for 'all' (no time filter). Pure. */
export function windowToDays(w: FunnelWindow): number | null {
  const map: Record<string, number> = { '7': 7, '30': 30, '90': 90, '180': 180, '365': 365 };
  return w === 'all' ? null : (map[w] ?? 90);
}

/** ISO lower-bound for a window (EPOCH for 'all'). */
function windowIso(w: FunnelWindow, nowMs: number): string {
  const days = windowToDays(w);
  return days === null ? EPOCH_ISO : new Date(nowMs - days * DAY_MS).toISOString();
}

/** Benchmark band (vs dev-tool medians) — greenMin/amberMin as fractions [0,1]. */
export interface Benchmark { greenMin: number; amberMin: number; label: string; }
export const FUNNEL_BENCHMARKS = {
  human_click_to_signup: { greenMin: 0.30, amberMin: 0.15, label: 'signup-form 30–55% norm' },
  human_signup_to_paid: { greenMin: 0.05, amberMin: 0.02, label: 'free→paid ~5% dev-tool median' },
  agent_conn_to_activated: { greenMin: 0.40, amberMin: 0.20, label: 'activation (≥1 real call)' },
  agent_activated_to_quota: { greenMin: 0.08, amberMin: 0.02, label: 'PQL (quota-crossing) rate' },
  agent_quota_to_paid: { greenMin: 0.05, amberMin: 0.01, label: 'monetization (quota→paid)' },
} as const;

/** RAG verdict of a rate vs its benchmark. null rate → 'a' (unknown/neutral). Pure. */
export function ragVerdict(rate: number | null, bench: Benchmark): 'g' | 'a' | 'r' {
  if (rate === null || !Number.isFinite(rate)) return 'a';
  if (rate >= bench.greenMin) return 'g';
  if (rate >= bench.amberMin) return 'a';
  return 'r';
}

/** n<30 → low-confidence (research-mandated small-sample guard). Pure. */
export function lowConfidence(n: number | null): boolean {
  return n !== null && n < 30;
}

export interface FunnelStage { key: string; label: string; sublabel: string; count: number | null; illustrative?: boolean; }
export interface FunnelTransition {
  from: string; to: string; rate: number | null; drop: number | null;
  verdict: 'g' | 'a' | 'r'; benchmark: string; low_confidence: boolean;
}

/** Build the transitions (rate/drop/verdict/low-confidence) between consecutive stages. Pure. */
export function buildTransitions(stages: FunnelStage[], benches: Benchmark[]): FunnelTransition[] {
  const out: FunnelTransition[] = [];
  for (let i = 0; i < stages.length - 1; i++) {
    const cur = stages[i], nxt = stages[i + 1], b = benches[i];
    const rate = (cur.count !== null && cur.count > 0 && nxt.count !== null) ? nxt.count / cur.count : null;
    const drop = (cur.count !== null && nxt.count !== null) ? cur.count - nxt.count : null;
    out.push({ from: cur.label, to: nxt.label, rate, drop, verdict: ragVerdict(rate, b), benchmark: b.label, low_confidence: lowConfidence(cur.count) });
  }
  return out;
}

/** The step furthest BELOW its green benchmark (the worst leak). Pure. */
export function pickBiggestLeak(trs: FunnelTransition[], benches: Benchmark[]): FunnelTransition | null {
  const scored = trs
    .map((t, i) => ({ t, score: t.rate === null ? Infinity : t.rate / (benches[i]?.greenMin || 1) }))
    .filter(s => s.score !== Infinity);
  if (!scored.length) return null;
  return scored.sort((a, b) => a.score - b.score)[0].t;
}

export interface HumanFunnel {
  window: FunnelWindow;
  engagement_proxy: { track_record_viewed: number | null; landing_cta_clicked: number | null; caveat: string };
  stages: FunnelStage[];
  transitions: FunnelTransition[];
  biggest_leak: FunnelTransition | null;
  by_channel: Array<{ channel: string; count: number; pct: number | null }>;
}

/** Human funnel (web → account → Stripe sub), windowed. Visitors is a proxy CONTEXT band
 *  (not a stage — clicks exceed the proxies, so it would invert the funnel). Stage funnel
 *  (per-window counts), not a cohort join — the attribution gap is flagged elsewhere. */
export async function getHumanFunnel(window: FunnelWindow, deps: ScoreboardDeps = defaultScoreboardDeps): Promise<HumanFunnel> {
  const nowMs = deps.now();
  const iso = windowIso(window, nowMs);
  const warnings: string[] = [];
  const trackRecord = await scalar(deps, 'human_track_record', `SELECT COUNT(DISTINCT session_id) AS c FROM funnel_events WHERE event_type = 'track_record_viewed' AND ts >= ?`, [iso], warnings);
  const landingCta = await scalar(deps, 'human_landing_cta', `SELECT COUNT(DISTINCT session_id) AS c FROM funnel_events WHERE event_type = 'landing_cta_clicked' AND ts >= ?`, [iso], warnings);
  const subscribeClicks = await scalar(deps, 'human_subscribe', `SELECT COUNT(*) AS c FROM signup_attribution WHERE created_at >= ?`, [iso], warnings);
  const signups = await scalar(deps, 'human_signup', `SELECT COUNT(*) AS c FROM free_keys WHERE created_at >= ?`, [iso], warnings);
  const paid = await scalar(deps, 'human_paid', `SELECT COUNT(*) AS c FROM subscriber_profiles WHERE converted_at >= ?`, [iso], warnings);
  let chanRows: Array<{ channel: string | null }> = [];
  try { chanRows = await deps.query<{ channel: string | null }>(`SELECT channel FROM signup_attribution WHERE created_at >= ?`, [iso]); }
  catch (err) { warnings.push(`human channel read failed: ${err instanceof Error ? err.message : String(err)}`); }
  const chanCounts: Record<string, number> = {};
  for (const r of chanRows) { const c = r.channel || 'direct'; chanCounts[c] = (chanCounts[c] ?? 0) + 1; }
  const chanTotal = chanRows.length;
  const by_channel = Object.entries(chanCounts).sort((a, b) => b[1] - a[1]).map(([channel, count]) => ({ channel, count, pct: chanTotal > 0 ? count / chanTotal : null }));
  const stages: FunnelStage[] = [
    { key: 'subscribe_click', label: 'Subscribe click', sublabel: 'Intent · /signup CTA', count: subscribeClicks },
    { key: 'signup', label: 'Signup', sublabel: 'Account · free key + referral', count: signups },
    { key: 'paid', label: 'Paid', sublabel: 'Conversion · Stripe sub', count: paid },
  ];
  const benches = [FUNNEL_BENCHMARKS.human_click_to_signup, FUNNEL_BENCHMARKS.human_signup_to_paid];
  const transitions = buildTransitions(stages, benches);
  return {
    window,
    engagement_proxy: { track_record_viewed: trackRecord, landing_cta_clicked: landingCta, caveat: 'engagement proxy — real visitor count NOT instrumented (landing is CDN/static; /signup is reachable directly). Not a funnel parent.' },
    stages, transitions, biggest_leak: pickBiggestLeak(transitions, benches), by_channel,
  };
}

export interface AgentFunnel {
  window: FunnelWindow;
  stages: FunnelStage[];
  transitions: FunnelTransition[];
  biggest_leak: FunnelTransition | null;
  quota_detail: { windowed_hard_block: number | null; soft_approaching: number | null; all_time_pqls: number | null };
  /** OPS-X402-WALLET-ATTRIBUTION-W1: distinct paying WALLETS (operator self-settle excluded) = the
   *  EXACT quota→paid conversion (the `paid_x402` stage count); `payments` is the secondary event
   *  count; `repeat_payers` = top wallets by call count (truncated, operator-excluded, operator-only). */
  paid_detail: { distinct_wallets: number | null; payments: number | null; repeat_payers: Array<{ wallet: string; calls: number }> };
  paid_note: string;
}

/** Agent funnel (MCP/API → x402), windowed. Quota-crossing = distinct sessions that hit the
 *  hard/block (90%+/100%) cap in-window; the all-time quota_usage≥100 count is a context chip;
 *  soft is a secondary "approaching" metric. Paid = x402 payment COUNT (not wallets). */
export async function getAgentFunnel(window: FunnelWindow, deps: ScoreboardDeps = defaultScoreboardDeps): Promise<AgentFunnel> {
  const nowMs = deps.now();
  const iso = windowIso(window, nowMs);
  const days = windowToDays(window);
  const thresholdMs = days === null ? 0 : nowMs - days * DAY_MS;
  const warnings: string[] = [];
  const connections = await scalar(deps, 'agent_connections', `SELECT COUNT(DISTINCT session_id) AS c FROM funnel_events WHERE event_type = 'mcp_connect' AND ts >= ?`, [iso], warnings);
  const activated = await scalar(deps, 'agent_activated', `SELECT COUNT(*) AS c FROM agent_sessions WHERE call_count >= 1 AND first_tier <> 'internal' AND first_seen >= ?`, [thresholdMs], warnings);
  const quotaCross = await scalar(deps, 'agent_quota_cross', `SELECT COUNT(DISTINCT session_id) AS c FROM funnel_events WHERE event_type IN ('quota_hit_hard','quota_hit_block') AND ts >= ?`, [iso], warnings);
  const quotaSoft = await scalar(deps, 'agent_quota_soft', `SELECT COUNT(DISTINCT session_id) AS c FROM funnel_events WHERE event_type = 'quota_hit_soft' AND ts >= ?`, [iso], warnings);
  const allTimePqls = await scalar(deps, 'agent_pql_alltime', `SELECT COUNT(*) AS c FROM quota_usage WHERE call_count >= 100`, [], warnings);
  // OPS-X402-WALLET-ATTRIBUTION-W1: quota→paid counts DISTINCT paying WALLETS (the ERC-3009 payer),
  // operator self-settle EXCLUDED (instrumentation_artifact) → the rate is EXACT, not payment events.
  // Payment COUNT is a secondary; NULL-wallet (pre-instrumentation) rows are excluded by COUNT(DISTINCT).
  // Base/USDC rail only (okx a2mcp settlements are not in processed_x402_payments — OPS-X402-OKX-METRICS-W1).
  const { clause: opClause, params: opParams } = operatorExclusionSql();
  const paidWalletsX402 = await scalar(deps, 'agent_x402_wallets',
    `SELECT COUNT(DISTINCT lower(payer_wallet)) AS c FROM processed_x402_payments WHERE created_at >= ? AND payer_wallet IS NOT NULL${opClause}`,
    [iso, ...opParams], warnings);
  const paidPaymentsX402 = await scalar(deps, 'agent_x402_payments',
    `SELECT COUNT(*) AS c FROM processed_x402_payments WHERE created_at >= ?`, [iso], warnings);
  const repeatPayers = await topX402Payers(deps, iso, opClause, opParams, warnings);
  const stages: FunnelStage[] = [
    { key: 'connections', label: 'Connections', sublabel: 'Reach · MCP / API', count: connections },
    { key: 'activated', label: 'Activated', sublabel: 'Value · made ≥1 call', count: activated },
    { key: 'quota_crossing', label: 'Quota-crossing', sublabel: 'PQL · hit 90%+/100% cap', count: quotaCross },
    { key: 'paid_x402', label: 'Paid', sublabel: 'Conversion · distinct paying wallets', count: paidWalletsX402 },
  ];
  const benches = [FUNNEL_BENCHMARKS.agent_conn_to_activated, FUNNEL_BENCHMARKS.agent_activated_to_quota, FUNNEL_BENCHMARKS.agent_quota_to_paid];
  const transitions = buildTransitions(stages, benches);
  return {
    window, stages, transitions, biggest_leak: pickBiggestLeak(transitions, benches),
    quota_detail: { windowed_hard_block: quotaCross, soft_approaching: quotaSoft, all_time_pqls: allTimePqls },
    paid_detail: { distinct_wallets: paidWalletsX402, payments: paidPaymentsX402, repeat_payers: repeatPayers },
    paid_note: 'Distinct paying WALLETS (COUNT DISTINCT payer_wallet), operator self-settle EXCLUDED (instrumentation_artifact) — the EXACT quota→paid conversion, not payment events. Secondary payment count in paid_detail.payments; pre-instrumentation (NULL-wallet) rows not counted. Base/USDC rail only — okx a2mcp settlements are not yet in this count (OPS-X402-OKX-METRICS-W1).',
  };
}

/** OPS-X402-WALLET-ATTRIBUTION-W1: top paying wallets by call count (operator-excluded, truncated,
 *  OPERATOR-ONLY display — addresses are on-chain-public but never published). Multi-row via
 *  deps.query; fail-soft to []. */
async function topX402Payers(
  deps: ScoreboardDeps,
  iso: string,
  opClause: string,
  opParams: string[],
  warnings: string[],
): Promise<Array<{ wallet: string; calls: number }>> {
  try {
    const rows = await deps.query<{ payer_wallet: string; c: number | string }>(
      `SELECT payer_wallet, COUNT(*) AS c FROM processed_x402_payments WHERE created_at >= ? AND payer_wallet IS NOT NULL${opClause} GROUP BY payer_wallet ORDER BY c DESC LIMIT 5`,
      [iso, ...opParams],
    );
    return rows.map((r) => ({ wallet: truncateWallet(r.payer_wallet), calls: safeCount(r.c) ?? 0 }));
  } catch (err) {
    warnings.push(`agent_x402_repeat failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export interface HoldUpside {
  window: FunnelWindow;
  external_calls: number | null;
  hold_calls: number | null;
  trade_calls: number | null;
  non_verdict_calls: number | null;
  active_agents: number | null;
  avg_calls_per_active_agent: number | null;
  hold_rate: number | null;
  upside: Array<{ price: number; amount: number | null }>;
  caveat: string;
}

/** HOLD-monetization upside — EXTERNAL agent calls only (is_bot_internal=false; NEVER the 36M
 *  lifetime counter, which request_log doesn't hold). HOLD/trade from request_log.verdict;
 *  null-verdict (chat/search/regime) excluded from the split. Upside = a LABELED projection. */
export async function getHoldUpside(window: FunnelWindow, deps: ScoreboardDeps = defaultScoreboardDeps): Promise<HoldUpside> {
  const nowMs = deps.now();
  const iso = windowIso(window, nowMs);
  const days = windowToDays(window);
  const thresholdMs = days === null ? 0 : nowMs - days * DAY_MS;
  const warnings: string[] = [];
  const externalCalls = await scalar(deps, 'hold_external', `SELECT COUNT(*) AS c FROM request_log WHERE is_bot_internal = false AND timestamp >= ?`, [iso], warnings);
  const holdCalls = await scalar(deps, 'hold_hold', `SELECT COUNT(*) AS c FROM request_log WHERE is_bot_internal = false AND verdict = 'HOLD' AND timestamp >= ?`, [iso], warnings);
  const tradeCalls = await scalar(deps, 'hold_trade', `SELECT COUNT(*) AS c FROM request_log WHERE is_bot_internal = false AND verdict IN ('BUY','SELL') AND timestamp >= ?`, [iso], warnings);
  const nonVerdict = await scalar(deps, 'hold_nonverdict', `SELECT COUNT(*) AS c FROM request_log WHERE is_bot_internal = false AND verdict IS NULL AND timestamp >= ?`, [iso], warnings);
  const activeAgents = await scalar(deps, 'hold_active', `SELECT COUNT(*) AS c FROM agent_sessions WHERE call_count >= 1 AND first_tier <> 'internal' AND first_seen >= ?`, [thresholdMs], warnings);
  const avg = safeRatio(externalCalls, activeAgents);
  const holdRate = (holdCalls !== null && tradeCalls !== null && holdCalls + tradeCalls > 0) ? holdCalls / (holdCalls + tradeCalls) : null;
  const upside = [0.001, 0.002, 0.005].map(price => ({ price, amount: holdCalls !== null ? holdCalls * price : null }));
  return {
    window, external_calls: externalCalls, hold_calls: holdCalls, trade_calls: tradeCalls, non_verdict_calls: nonVerdict,
    active_agents: activeAgents, avg_calls_per_active_agent: avg, hold_rate: holdRate, upside,
    caveat: 'External agent calls only (internal seed/scan excluded; request_log ≠ the 36M lifetime counter). Non-verdict calls (chat/search/regime) excluded from the HOLD/trade split. Estimate only — HOLDs stay free until you decide otherwise.',
  };
}

// ── Scoreboard shape ──────────────────────────────────────────────────────────

export interface FunnelScoreboard {
  computed_at: string;
  window: { days: number; from: string; to: string };
  data_freshness: {
    snapshot_generated_at: string | null;
    stripe_source: ActiveSubscriberTierCensus['source'] | 'unavailable';
  };
  paying_subscribers: {
    headline_source: 'stripe_live' | 'stripe_cache' | 'subscriber_profiles_fallback' | 'unavailable';
    by_tier: { starter: number | null; pro: number | null; enterprise: number | null };
    total: number | null;
    x402_separate: { payments_in_window: number | null; distinct_wallets_in_window: number | null; note: string };
    enrichment: { profiles_total: number; by_channel: Record<string, number> };
    reconciliation: Reconciliation;
  };
  free_signups: {
    reach_mcp_connect_all_time: number | null; // context line, NOT a signup
    signup_intent: {
      total_all_time: number | null;
      by_channel: Record<string, number>;
      weekly: Array<{ week: string; total: number; by_channel: Record<string, number> }>;
    };
    free_accounts: number | null; // free_keys + signup_emails = the free→paid denominator
    awareness_activation_collapse: { reach: number | null; intent: number | null; accounts: number | null };
  };
  conversion: {
    paid_over_free_accounts: number | null;
    paid_over_signup_intent: number | null;
    joinable_cohort: { attributed_conversions: number; total_conversions: number; note: string };
    unattributable_pct: number | null;
  };
  retention: RetentionBreakdown;
  intent_panel: {
    upgrade_cta_clicked: number | null;
    landing_cta_clicked: number | null;
    quota_hits: { soft: number | null; hard: number | null; block: number | null };
    tagged_vs_direct: { tagged: number; direct: number; direct_pct: number | null };
    identity_coverage: FunnelSnapshot['identity_coverage'];
  };
  /** The Telegram daily-digest client-TYPE split (24h), projected from the same getUsageStats(). */
  client_activity_24h: ClientActivity24h;
  /** FUNNEL-SCOREBOARD-V2: the two separate funnels (human web→Stripe · agent MCP→x402) + HOLD upside, windowed. */
  human_funnel: HumanFunnel;
  agent_funnel: AgentFunnel;
  hold_upside: HoldUpside;
  /** FUNNEL-FIX-ATTRIBUTION-W1: source-classified channel breakdown (first_touch_source), windowed. */
  source_channels: {
    by_source: Array<{ source: string; medium: string; count: number; pct: number | null; low_confidence: boolean }>;
    total: number;
    classified: number;
    coverage_pct: number | null; // classified / total (share NOT direct/unknown)
    note: string;
  };
  daily: Array<{ date: string; signup_intent: number; conversions: number }>;
  warnings: string[];
}

// ── Dependency injection ──────────────────────────────────────────────────────

export interface ScoreboardDeps {
  snapshot: (opts: { days: number }) => Promise<FunnelSnapshot>;
  stripeCensus: (now?: number) => Promise<ActiveSubscriberTierCensus | null>;
  listProfiles: () => Promise<SubscriberProfileRow[]>;
  usageStats: () => Promise<Record<string, unknown>>;
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
  now: () => number;
}

export const defaultScoreboardDeps: ScoreboardDeps = {
  snapshot: (opts) => generateFunnelSnapshot(opts),
  stripeCensus: (now) => countActiveSubscriptionsByTier(now),
  listProfiles: () => listSubscriberProfiles({ limit: 500 }),
  usageStats: () => getUsageStats(),
  query: (sql, params) => dbQuery(sql, params ?? []),
  now: () => Date.now(),
};

/** A single fail-open scalar read: returns null + a warning on any error/empty. */
async function scalar(
  deps: ScoreboardDeps,
  label: string,
  sql: string,
  params: unknown[],
  warnings: string[],
): Promise<number | null> {
  try {
    const rows = await deps.query<{ c: number | string }>(sql, params);
    return safeCount(rows[0]?.c);
  } catch (err) {
    warnings.push(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Compute the always-on funnel scoreboard. `opts.days` scopes the composed
 * snapshot + the x402/daily windows (default 90 — the full young-funnel span);
 * subscriber/free-account/reach totals are all-time by design.
 */
export async function getFunnelScoreboard(
  opts: { days?: number; window?: FunnelWindow } = {},
  deps: ScoreboardDeps = defaultScoreboardDeps,
): Promise<FunnelScoreboard> {
  const window: FunnelWindow = opts.window ?? 'all';
  const days = Math.min(Math.max(Math.trunc(opts.days ?? windowToDays(window) ?? 90), 1), 365);
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const fromIso = new Date(nowMs - days * DAY_MS).toISOString();
  const warnings: string[] = [];

  // Compose the standing snapshot (funnel stages + intent + tier cohorts + identity coverage).
  let snap: FunnelSnapshot | null = null;
  try {
    snap = await deps.snapshot({ days });
    if (snap.warnings?.length) warnings.push(...snap.warnings.map(w => `snapshot: ${w}`));
  } catch (err) {
    warnings.push(`snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Metric 1: paying subscribers (Stripe-live canonical + profiles enrichment + x402 separate) ──
  let census: ActiveSubscriberTierCensus | null = null;
  try { census = await deps.stripeCensus(nowMs); } catch (err) {
    warnings.push(`stripe census failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let profiles: SubscriberProfileRow[] = [];
  try { profiles = await deps.listProfiles(); } catch (err) {
    warnings.push(`listProfiles failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const profAgg = aggregateProfiles(profiles);
  const activeProfiles = profiles.filter(p => (p.status ?? '').toLowerCase() === 'active');
  const reconciliation = reconcileCounts(census ? census.total : null, activeProfiles.length);
  const x402Payments = await scalar(
    deps, 'x402_payments',
    `SELECT COUNT(*) AS c FROM processed_x402_payments WHERE created_at >= ?`,
    [fromIso], warnings,
  );
  // OPS-X402-WALLET-ATTRIBUTION-W1 (Q5): distinct paying wallets alongside the payment count,
  // operator self-settle excluded — consistent with the agent-funnel conversion metric.
  const { clause: opClauseCensus, params: opParamsCensus } = operatorExclusionSql();
  const x402Wallets = await scalar(
    deps, 'x402_wallets',
    `SELECT COUNT(DISTINCT lower(payer_wallet)) AS c FROM processed_x402_payments WHERE created_at >= ? AND payer_wallet IS NOT NULL${opClauseCensus}`,
    [fromIso, ...opParamsCensus], warnings,
  );

  const paying_subscribers: FunnelScoreboard['paying_subscribers'] = {
    headline_source: census ? census.source : (profiles.length ? 'subscriber_profiles_fallback' : 'unavailable'),
    by_tier: census
      ? { starter: census.starter, pro: census.pro, enterprise: census.enterprise }
      : { starter: null, pro: null, enterprise: null },
    total: census ? census.total : (profiles.length ? activeProfiles.length : null),
    x402_separate: {
      payments_in_window: x402Payments,
      distinct_wallets_in_window: x402Wallets,
      note: 'x402 micro-payments are a SEPARATE rail (per-call USDC, not subscriptions) — never folded into the subscriber headline. distinct_wallets excludes operator self-settle (instrumentation_artifact); Base rail only (okx a2mcp not yet counted — OPS-X402-OKX-METRICS-W1).',
    },
    enrichment: { profiles_total: profAgg.total, by_channel: profAgg.byChannel },
    reconciliation,
  };

  // ── Metric 2: free signups micro-funnel (Reach → Intent → Accounts) ──
  const reachAllTime = await scalar(
    deps, 'reach_mcp_connect',
    `SELECT COUNT(DISTINCT session_id) AS c FROM funnel_events WHERE event_type = 'mcp_connect'`,
    [], warnings,
  );
  let signupRows: Array<{ created_at: unknown; channel: string | null }> = [];
  try {
    signupRows = await deps.query<{ created_at: unknown; channel: string | null }>(
      `SELECT created_at, channel FROM signup_attribution`, [],
    );
  } catch (err) {
    warnings.push(`signup_attribution read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const signupByChannel: Record<string, number> = {};
  for (const r of signupRows) {
    const ch = r.channel || 'unknown';
    signupByChannel[ch] = (signupByChannel[ch] ?? 0) + 1;
  }
  const signupWeekly = bucketWeeklyByChannel(
    signupRows.map(r => ({ ms: toEpochMs(r.created_at), channel: r.channel || 'unknown' })),
  );
  const freeKeys = await scalar(deps, 'free_keys', `SELECT COUNT(*) AS c FROM free_keys`, [], warnings);
  const signupEmails = await scalar(deps, 'signup_emails', `SELECT COUNT(*) AS c FROM signup_emails`, [], warnings);
  const freeAccounts = (freeKeys === null && signupEmails === null) ? null : (freeKeys ?? 0) + (signupEmails ?? 0);
  const signupIntentTotal = signupRows.length ? signupRows.length : (signupRows.length === 0 && warnings.some(w => w.startsWith('signup_attribution')) ? null : 0);

  const free_signups: FunnelScoreboard['free_signups'] = {
    reach_mcp_connect_all_time: reachAllTime,
    signup_intent: { total_all_time: signupIntentTotal, by_channel: signupByChannel, weekly: signupWeekly },
    free_accounts: freeAccounts,
    awareness_activation_collapse: { reach: reachAllTime, intent: signupIntentTotal, accounts: freeAccounts },
  };

  // ── Metric 3: free→paid conversion (both denominators + honest unattributable) ──
  const paidTotal = paying_subscribers.total;
  const attributedConversions = profiles.filter(p => p.attribution_captured === true && p.converted_at).length;
  const totalConversions = profiles.filter(p => !!p.converted_at).length;
  const unattributable = totalConversions > 0
    ? (totalConversions - attributedConversions) / totalConversions
    : null;
  const conversion: FunnelScoreboard['conversion'] = {
    paid_over_free_accounts: safeRatio(paidTotal, freeAccounts),
    paid_over_signup_intent: safeRatio(paidTotal, signupIntentTotal),
    joinable_cohort: {
      attributed_conversions: attributedConversions,
      total_conversions: totalConversions,
      note: 'Cohort join is weak until the identity bridge (follow-up H0-FUNNEL-IDENTITY-BRIDGE-W1) — most conversions carry attribution_captured=false',
    },
    unattributable_pct: unattributable,
  };

  // ── Metric 4: retention — session return-retention, split by tier + connection source ──
  // (d90 null until a cohort matures; the bot alert-engine `internal` is excluded from
  // every curve so free/paid user retention isn't drowned by continuous polling.)
  let sessionRows: Array<{ session_id: unknown; first_seen: unknown; last_seen: unknown; first_tier: unknown; tiers_seen: unknown }> = [];
  try {
    sessionRows = await deps.query<{ session_id: unknown; first_seen: unknown; last_seen: unknown; first_tier: unknown; tiers_seen: unknown }>(
      `SELECT session_id, first_seen, last_seen, first_tier, tiers_seen FROM agent_sessions WHERE first_seen >= ?`,
      [nowMs - 180 * DAY_MS],
    );
  } catch (err) {
    warnings.push(`agent_sessions read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Connection-layer ?src= acquisition source per session (the only channel that joins
  // to session activity). Parsed from mcp_connect meta_json in JS (cross-backend; mirrors
  // getIdentityCoverage in funnel-snapshot.ts). First labeled connect wins per session.
  let connectRows: Array<{ session_id: unknown; meta_json: unknown }> = [];
  try {
    connectRows = await deps.query<{ session_id: unknown; meta_json: unknown }>(
      `SELECT session_id, meta_json FROM funnel_events WHERE event_type = 'mcp_connect'`,
      [],
    );
  } catch (err) {
    warnings.push(`mcp_connect source read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const sourceBySession = new Map<string, string>();
  for (const r of connectRows) {
    const sid = typeof r.session_id === 'string' ? r.session_id : null;
    if (!sid || sourceBySession.has(sid)) continue;
    let src = 'untagged';
    try {
      const m = r.meta_json ? (JSON.parse(String(r.meta_json)) as Record<string, unknown>) : {};
      if (typeof m.src === 'string' && m.src) src = m.src;
      else if (typeof m.source === 'string' && m.source) src = m.source;
    } catch { /* malformed meta → untagged */ }
    sourceBySession.set(sid, src);
  }
  const retSessions: RetentionSession[] = [];
  for (const r of sessionRows) {
    const fs = toEpochMs(r.first_seen);
    const ls = toEpochMs(r.last_seen);
    if (fs === null || ls === null) continue;
    const sid = typeof r.session_id === 'string' ? r.session_id : '';
    retSessions.push({
      firstSeenMs: fs,
      lastSeenMs: ls,
      tierBucket: classifyTierBucket(r.first_tier, r.tiers_seen),
      channel: sourceBySession.get(sid) ?? 'untagged',
    });
  }
  const retention = computeRetentionBreakdown(retSessions, nowMs);

  // ── Intent panel ──
  const tagged = Object.entries(signupByChannel)
    .filter(([ch]) => ch !== 'direct' && ch !== 'unknown')
    .reduce((s, [, n]) => s + n, 0);
  const direct = signupByChannel['direct'] ?? 0;
  const intent_panel: FunnelScoreboard['intent_panel'] = {
    upgrade_cta_clicked: snap?.funnel.upgrade_cta_clicked ?? null,
    landing_cta_clicked: snap?.funnel.landing_cta_clicked ?? null,
    quota_hits: {
      soft: snap?.funnel.quota_hit_soft ?? null,
      hard: snap?.funnel.quota_hit_hard ?? null,
      block: snap?.funnel.quota_hit_block ?? null,
    },
    tagged_vs_direct: { tagged, direct, direct_pct: safeRatio(direct, tagged + direct) },
    identity_coverage: snap?.identity_coverage ?? { identified: null, fallback: null, anonymous: null, coverage_pct: null },
  };

  // ── Client-type split (24h) — projected from the digest's own getUsageStats ──
  let usage: Record<string, unknown> | null = null;
  try { usage = await deps.usageStats(); } catch (err) {
    warnings.push(`usageStats failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const client_activity_24h = projectClientActivity(usage);

  // ── V2 dual funnels (human + agent) + HOLD upside, scoped to the selected window ──
  const [human_funnel, agent_funnel, hold_upside] = await Promise.all([
    getHumanFunnel(window, deps),
    getAgentFunnel(window, deps),
    getHoldUpside(window, deps),
  ]);

  // ── FUNNEL-FIX-ATTRIBUTION-W1: source-classified channels (first_touch_source), windowed ──
  const srcThresholdMs = days >= 365 && window === 'all' ? 0 : nowMs - days * DAY_MS;
  let srcRows: Array<{ source: string | null; c: number | string }> = [];
  try {
    srcRows = await deps.query<{ source: string | null; c: number | string }>(
      `SELECT first_touch_source AS source, COUNT(*) AS c FROM agent_sessions WHERE first_tier <> 'internal' AND first_seen >= ? GROUP BY first_touch_source`,
      [srcThresholdMs],
    );
  } catch (err) {
    warnings.push(`source_channels read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const srcTotal = srcRows.reduce((s, r) => s + (safeCount(r.c) ?? 0), 0);
  const srcClassified = srcRows.filter(r => r.source && r.source !== 'unknown').reduce((s, r) => s + (safeCount(r.c) ?? 0), 0);
  const source_channels: FunnelScoreboard['source_channels'] = {
    by_source: srcRows.map(r => {
      const count = safeCount(r.c) ?? 0;
      return {
        source: r.source || 'direct/unknown',
        medium: r.source ? mediumForSource(r.source as AttributionSource) : 'direct',
        count,
        pct: srcTotal > 0 ? count / srcTotal : null,
        low_confidence: lowConfidence(count),
      };
    }).sort((a, b) => b.count - a.count),
    total: srcTotal,
    classified: srcClassified,
    coverage_pct: srcTotal > 0 ? srcClassified / srcTotal : null,
    note: 'first_touch_source per session (write-once), new-traffic-forward — pre-fix sessions have no source (counted as direct/unknown). Internal bot excluded.',
  };

  // ── Daily timeseries (signup intent + conversions) ──
  const signupDaily = bucketDaily(signupRows.map(r => toEpochMs(r.created_at)), nowMs, Math.min(days, 90));
  const convDaily = bucketDaily(profiles.map(p => toEpochMs(p.converted_at)), nowMs, Math.min(days, 90));
  const daily = signupDaily.map((d, i) => ({
    date: d.date,
    signup_intent: d.count,
    conversions: convDaily[i]?.count ?? 0,
  }));

  return {
    computed_at: nowIso,
    window: { days, from: fromIso, to: nowIso },
    data_freshness: {
      snapshot_generated_at: snap?.generated_at ?? null,
      stripe_source: census ? census.source : 'unavailable',
    },
    paying_subscribers,
    free_signups,
    conversion,
    retention,
    intent_panel,
    client_activity_24h,
    human_funnel,
    agent_funnel,
    hold_upside,
    source_channels,
    daily,
    warnings,
  };
}
