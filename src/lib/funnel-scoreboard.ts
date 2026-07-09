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
    x402_separate: { payments_in_window: number | null; note: string };
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
  retention: RetentionCurve & { basis: string; coverage_caveat: string };
  intent_panel: {
    upgrade_cta_clicked: number | null;
    landing_cta_clicked: number | null;
    quota_hits: { soft: number | null; hard: number | null; block: number | null };
    tagged_vs_direct: { tagged: number; direct: number; direct_pct: number | null };
    identity_coverage: FunnelSnapshot['identity_coverage'];
  };
  /** The Telegram daily-digest client-TYPE split (24h), projected from the same getUsageStats(). */
  client_activity_24h: ClientActivity24h;
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
  opts: { days?: number } = {},
  deps: ScoreboardDeps = defaultScoreboardDeps,
): Promise<FunnelScoreboard> {
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 90), 1), 365);
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

  const paying_subscribers: FunnelScoreboard['paying_subscribers'] = {
    headline_source: census ? census.source : (profiles.length ? 'subscriber_profiles_fallback' : 'unavailable'),
    by_tier: census
      ? { starter: census.starter, pro: census.pro, enterprise: census.enterprise }
      : { starter: null, pro: null, enterprise: null },
    total: census ? census.total : (profiles.length ? activeProfiles.length : null),
    x402_separate: {
      payments_in_window: x402Payments,
      note: 'x402 micro-payments are a SEPARATE rail (per-call USDC, not subscriptions) — never folded into the subscriber headline',
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

  // ── Metric 4: retention curve (agent_sessions return-retention; d90 null until mature) ──
  let sessionRows: Array<{ first_seen: unknown; last_seen: unknown }> = [];
  try {
    sessionRows = await deps.query<{ first_seen: unknown; last_seen: unknown }>(
      `SELECT first_seen, last_seen FROM agent_sessions WHERE first_seen >= ?`,
      [nowMs - 180 * DAY_MS],
    );
  } catch (err) {
    warnings.push(`agent_sessions read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const sessions = sessionRows
    .map(r => ({ firstSeenMs: toEpochMs(r.first_seen), lastSeenMs: toEpochMs(r.last_seen) }))
    .filter((s): s is { firstSeenMs: number; lastSeenMs: number } => s.firstSeenMs !== null && s.lastSeenMs !== null);
  const curve = computeRetentionCurve(sessions, nowMs);
  const retention: FunnelScoreboard['retention'] = {
    ...curve,
    basis: 'agent_sessions return-retention: a session is retained at dN if last_seen − first_seen ≥ N days; eligible only when old enough to observe N days',
    coverage_caveat: 'Cookieless: anon (uuid) sessions cannot be stitched across visits and read as non-retained; see intent_panel.identity_coverage for the stitchable share',
  };

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
    daily,
    warnings,
  };
}
