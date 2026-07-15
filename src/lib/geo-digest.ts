/**
 * GEO-MEASUREMENT-W4 — results-driving weekly digest builder.
 *
 * PURE module (no DB, no Telegram, no Date): the cron fetches the data + passes
 * it in; this turns the probe from a metric-dump scoreboard into a flywheel —
 * a momentum VERDICT (one source of truth → emoji + words can't contradict),
 * an ATTRIBUTION loop (did the gap we shipped move that query?), leading-
 * indicators-first, a competitor placement map, and ONE queued move.
 *
 * Fires NOTHING itself (the cron owns the single digest send + the preserved WoW
 * warning alert). No schema change — reads already-existing geo_* fields.
 */

import { isSignificantDecline, DEFAULT_ALERT_HYGIENE, type AlertHygieneConfig } from './geo-alert-hygiene.js';
// GEO-TARGET-DIGEST-REDESIGN-W1 — type-only imports (erased at compile → geo-digest stays a PURE
// leaf; no DB/Date code lands here). `target_set` classification + the per-query attribution rate.
import type { TargetSet } from './geo-decide.js';
import type { QueryAttributionRate } from './geo-rates.js';

export type Verdict = 'gaining' | 'holding' | 'slipping';

/**
 * GEO-TARGET-DIGEST-REDESIGN-W1 (e) — conversion-tier badge. Keeps Tier-B citation volume visually
 * distinct from Tier-A pipeline so brand-presence never masquerades as revenue. Projects from the
 * `target_set` SoT (geo-objective.yaml), threaded in by the cron. Empty for unclassified/measure_only.
 */
export function tierBadge(tier?: string): string {
  return tier === 'A'
    ? '🎯 conversion'
    : tier === 'B'
      ? '📣 brand-presence'
      : tier === 'contested'
        ? '🤝 earned'
        : '';
}

/** 0..1 rate → integer percent (clamped). */
function ratePct(r: number): number {
  return Math.round(Math.max(0, Math.min(1, r)) * 100);
}
/** signed integer rate-point delta for display, e.g. "+5" / "−3" / "±0". */
function signedPct(delta: number): string {
  const p = Math.round(delta * 100);
  return p > 0 ? `+${p}` : p < 0 ? `−${Math.abs(p)}` : '±0';
}

const VERDICT_META: Record<Verdict, { emoji: string; word: string }> = {
  gaining: { emoji: '🟢', word: 'GAINING' },
  holding: { emoji: '🟡', word: 'HOLDING' },
  slipping: { emoji: '🔴', word: 'SLIPPING' },
};

export interface Momentum {
  verdict: Verdict;
  emoji: string;
  headline: string;
  drivers: string[];
}

export interface MomentumDeltas {
  citationsThisWeek: number;
  citationsLastWeek: number;
  /** algovault-attributed source_domains appearing this week but not in the prior 4w. */
  newTrustedDomains: string[];
  sovThisWeek: number;
  sovLastWeek: number;
  mentionRateThisWeek: number; // %
  mentionRateLastWeek: number; // %
  wowDropCount: number; // # models with >20% WoW mention-rate drop — RAW transparency only (NOT the gate)
  wowDropSummary: string; // e.g. "claude-web -25%" — shown as supporting detail, never the trigger
  /**
   * OPS-GEO-PROBE-SIGNIFICANCE-GATE-W1 — weekly cited-answer counts, MOST-RECENT-FIRST
   * (this week, last week, two weeks ago, …). Feeds the significance gate that decides
   * SLIPPING. Optional → falls back to [citationsThisWeek, citationsLastWeek] (a single
   * transition can never satisfy the consecutive-cycles gate, so absent history ⇒ HOLDING).
   */
  weeklyCitations?: number[];
  /** resolved alert-hygiene gate config (from geo-objective.yaml `alert_hygiene`). */
  alertHygiene?: AlertHygieneConfig;
}

/**
 * R1 — momentum verdict. ONE source of truth: emoji + headline word BOTH derive
 * from `verdict` (single-source invariant, locked by the unit test). Stage-aware:
 * while mention-rate ≈ 0 the leading indicators (citations, new domains) carry it.
 */
export function computeMomentum(d: MomentumDeltas): Momentum {
  const drivers: string[] = [];
  const citDelta = d.citationsThisWeek - d.citationsLastWeek;
  const sovDelta = d.sovThisWeek - d.sovLastWeek;
  const mentionDelta = d.mentionRateThisWeek - d.mentionRateLastWeek;

  let up = 0;
  let down = 0;
  if (citDelta > 0) {
    up++;
    drivers.push(`citations ↑ ${d.citationsLastWeek}→${d.citationsThisWeek}`);
  } else if (citDelta < 0) {
    down++;
    drivers.push(`citations ↓ ${d.citationsLastWeek}→${d.citationsThisWeek}`);
  }
  if (d.newTrustedDomains.length > 0) {
    up++;
    drivers.push(`new domain: ${d.newTrustedDomains[0]}`);
  }
  if (sovDelta > 0.005) up++;
  else if (sovDelta < -0.005) down++;
  if (mentionDelta > 1) {
    up++;
    drivers.push(`mention ↑ ${d.mentionRateLastWeek.toFixed(0)}→${d.mentionRateThisWeek.toFixed(0)}%`);
  } else if (mentionDelta < -1) {
    down++;
  }

  // OPS-GEO-PROBE-SIGNIFICANCE-GATE-W1 — 🔴 SLIPPING fires ONLY on a statistically
  // meaningful, SUSTAINED citation decline, computed in the single shared gate
  // (isSignificantDecline). Raw per-engine mention-rate wobble (wowDropSummary) is shown
  // for transparency but never fires — LLM retrieval is non-deterministic (~16% noise
  // floor) so a single tiny-sample >20% dip is noise, not a strategy signal.
  const decline = isSignificantDecline(
    d.weeklyCitations ?? [d.citationsThisWeek, d.citationsLastWeek],
    d.alertHygiene ?? DEFAULT_ALERT_HYGIENE,
  );

  let verdict: Verdict;
  let reason: string;
  if (decline.slipping) {
    verdict = 'slipping';
    reason = d.wowDropSummary ? `${decline.reason}; per-engine: ${d.wowDropSummary}` : decline.reason;
  } else if (up > down) {
    verdict = 'gaining';
    reason = `${up} leading signal${up === 1 ? '' : 's'} moved up`;
  } else if (down > up) {
    // The OLD rule fired SLIPPING on any net-down week; the significance gate suppresses
    // that noise → HOLDING, surfacing WHY it held (low sample / within noise / N down-weeks).
    verdict = 'holding';
    reason = decline.reason;
  } else {
    // up === down (incl. 0/0): holding — stage-aware framing keeps it honest + motivating
    verdict = 'holding';
    if (d.citationsThisWeek > 0 || d.newTrustedDomains.length > 0) {
      reason =
        `pre-visibility, but ${d.citationsThisWeek} citation${d.citationsThisWeek === 1 ? '' : 's'} live` +
        (d.newTrustedDomains.length ? ` + ${d.newTrustedDomains.length} new domain` : '');
    } else if (up === 0) {
      reason = 'pre-visibility, no movement this week';
    } else {
      reason = `pre-visibility, mixed signals (${up} up, ${down} down)`;
    }
  }

  const meta = VERDICT_META[verdict];
  return { verdict, emoji: meta.emoji, headline: `${meta.word} — ${reason}.`, drivers };
}

export type AttributionStatus = 'worked' | 'too_early' | 'no_move';

const ATTR_EMOJI: Record<AttributionStatus, string> = { worked: '✅', too_early: '⏳', no_move: '➖' };

export interface AttributionGap {
  query_id: string;
  /** target-set conversion tier (for the badge) — 'A' | 'B' | 'contested'; absent ⇒ no badge. */
  tier?: string;
  recommended_action: string | null;
  injected_at: string; // ISO
  days_since_injected: number;
  /** days of geo_mentions data AFTER injected_at (0 if no post-probe yet). */
  post_data_days: number;
  /**
   * GEO-TARGET-DIGEST-REDESIGN-W1 (a) — the full-funnel before/after RATE deltas (mention + cited
   * + SoV, each with Wilson CIs), projected from the shared geo-rates `computeAttributionRates`
   * (which reuses the same `wilsonInterval` behind getQueryRates — single-derivation, no inline rate).
   */
  rate: QueryAttributionRate;
}

export interface AttributionLine {
  query_id: string;
  status: AttributionStatus;
  emoji: string;
  text: string;
}

/** A move-effect above the LLM-retrieval noise floor (rate points, 0..1). */
const ATTRIBUTION_EPS = 0.02;

/**
 * GEO-TARGET-DIGEST-REDESIGN-W1 (a) — the full-funnel attribution loop (centerpiece). For each
 * acted-on target query ≥7d old, report the mention-rate Δ + cited-rate Δ + SoV Δ (before→after the
 * move) with CIs. A move **WORKS if it lifts the LEADING indicator (mention) even while cited is
 * flat** — fixing the old cited-only false-negative that read "no movement" when mention actually
 * rose. Rates/CIs come from `computeAttributionRates` (shared `wilsonInterval`); this fn only judges
 * + renders. too-early while <7d of post-move data.
 */
export function computeAttribution(gaps: AttributionGap[]): AttributionLine[] {
  const out: AttributionLine[] = [];
  for (const g of gaps) {
    if (g.days_since_injected < 7) continue;
    const r = g.rate;
    const b = r.before;
    const a = r.after;
    const badge = tierBadge(g.tier);
    const tag = `${g.query_id}${badge ? ` [${badge}]` : ''}`;
    const lowConf = a.low_confidence || b.low_confidence ? ' ⚠️ low-confidence' : '';
    // The full-funnel line: mention (leading) + cited (lagging) + SoV, each before→after with the Δ,
    // plus the 95% CI on the AFTER mention/cited rate so a small-n move reads honest, not precise-but-wrong.
    const funnel =
      `mention ${ratePct(b.mention_rate)}→${ratePct(a.mention_rate)}% (${signedPct(r.mention_delta)}, CI ${ratePct(a.mention_rate_lo)}–${ratePct(a.mention_rate_hi)}%) · ` +
      `cited ${ratePct(b.cited_rate)}→${ratePct(a.cited_rate)}% (${signedPct(r.cited_delta)}, CI ${ratePct(a.cited_rate_lo)}–${ratePct(a.cited_rate_hi)}%) · ` +
      `SoV ${b.avg_sov.toFixed(2)}→${a.avg_sov.toFixed(2)} (${r.sov_delta >= 0 ? '+' : '−'}${Math.abs(r.sov_delta).toFixed(2)})`;

    let status: AttributionStatus;
    let text: string;
    if (a.total_runs === 0 || g.post_data_days < 7) {
      status = 'too_early';
      text = `${tag}: shipped, only ${Math.round(g.post_data_days)}d of post-data — too early to call.${lowConf} ${funnel}`;
    } else if (r.mention_delta > ATTRIBUTION_EPS || r.cited_delta > ATTRIBUTION_EPS) {
      status = 'worked';
      const lead =
        r.mention_delta > ATTRIBUTION_EPS
          ? 'leading indicator (mention) up'
          : 'cited up';
      text = `${tag}: ${lead} after the move → it worked, do more.${lowConf} ${funnel}`;
    } else {
      status = 'no_move';
      text = `${tag}: no lift on the leading indicator → try a different angle.${lowConf} ${funnel}`;
    }
    out.push({ query_id: g.query_id, status, emoji: ATTR_EMOJI[status], text });
  }
  return out;
}

// ── GEO-TARGET-DIGEST-REDESIGN-W1 (c) — per-query "our action" status ──────────────────────────

export type OurActionStatus = 'posted' | 'in_flight' | 'none';
const OUR_ACTION_EMOJI: Record<OurActionStatus, string> = { posted: '✅', in_flight: '🔵', none: '⚪' };

/** One target query's "what have WE done + the trend since" row (built by the cron; pure render here). */
export interface OurActionRow {
  query_id: string;
  /** conversion tier ('A' | 'B' | 'contested') for the badge + section grouping. */
  tier?: string;
  status: OurActionStatus;
  /** YYYY-MM-DD the answer was posted/injected (status='posted'), else null. */
  posted_date: string | null;
  /** this-week engine-pooled rates (rollupByQuery) — the trend since our action. */
  mention_rate_pct: number;
  cited_rate_pct: number;
  low_confidence: boolean;
}

/** Deterministic tier order for the our-action + who's-winning sections. */
const TIER_ORDER: Record<string, number> = { A: 0, B: 1, contested: 2 };

/**
 * GEO-TARGET-DIGEST-REDESIGN-W1 (c) — the per-query "our action" section: for every target query,
 * OUR status (posted+date / decision in-flight / no action yet) + the mention/cited trend since.
 * Fixes the old digest calling a query "OPEN, your best shot" when we had already posted it. Pure;
 * grouped Tier-A → B → contested, each row badged (e). `undefined`/empty ⇒ section omitted.
 */
export function buildOurActionSection(rows: OurActionRow[] | null | undefined): string[] {
  if (!rows || rows.length === 0) return [];
  const L: string[] = ['', "*🧭 OUR ACTION PER TARGET QUERY* (what we've shipped + the trend since)"];
  const sorted = [...rows].sort(
    (x, y) => (TIER_ORDER[x.tier ?? ''] ?? 9) - (TIER_ORDER[y.tier ?? ''] ?? 9) || x.query_id.localeCompare(y.query_id),
  );
  for (const r of sorted) {
    const badge = tierBadge(r.tier);
    const status =
      r.status === 'posted'
        ? `posted${r.posted_date ? ` ${r.posted_date}` : ''}`
        : r.status === 'in_flight'
          ? 'decision in-flight (queued, not yet shipped)'
          : 'no action yet';
    const lc = r.low_confidence ? ' ⚠️' : '';
    L.push(
      `${OUR_ACTION_EMOJI[r.status]} ${r.query_id}${badge ? ` [${badge}]` : ''}: ${status} — mention ${Math.round(r.mention_rate_pct)}% · cited ${Math.round(r.cited_rate_pct)}%${lc}`,
    );
  }
  return L;
}

/** Friendly engine name from the stored model string (claude-haiku → claude-web, etc.). */
export function shortEngine(model: string): string {
  const m = (model || '').toLowerCase();
  if (m.startsWith('claude')) return 'claude-web';
  if (m.startsWith('sonar')) return 'perplexity';
  if (m.startsWith('gpt') || m.startsWith('chatgpt')) return 'chatgpt';
  if (m.startsWith('gemini')) return 'gemini';
  return model;
}

// ── R5 (AI-CRAWLER-ACCESS-W2): per-engine index-presence ──────────────────────

/** One engine's index-presence input (from the presence-tier probe). */
export interface IndexPresenceRow {
  model: string; // stored model string (claude-haiku… / sonar / gpt-4.1-mini / gemini-2.5-flash)
  present: boolean; // majority mention_found for query_tier='presence' (engine retrieved algovault.com)
}

/** Each engine → its retrieval substrate (the index ChatGPT/Claude/Gemini draw from). */
const ENGINE_SUBSTRATE: Record<string, string> = {
  chatgpt: 'Bing',
  'claude-web': 'Brave',
  gemini: 'Google',
  perplexity: 'own',
};
/** Stable display order: ChatGPT (largest reach) → Claude → Gemini → Perplexity. */
const PRESENCE_ORDER = ['chatgpt', 'claude-web', 'gemini', 'perplexity'];

export interface IndexPresence {
  engines: Array<{ engine: string; present: boolean; substrate: string }>;
  /** ≥1 engine NOT indexed → blocked-eligibility (🔴 fix-now, distinct from low authority). */
  blocked: boolean;
  /** engine display names that are ✗ (e.g. ["claude"]). */
  missing: string[];
  hasData: boolean;
  /** one-line summary, e.g. "chatgpt ✓ (Bing) · claude ✗ (Brave) · gemini ✓ (Google) · perplexity ✓". */
  line: string;
}

/** Display label (claude-web → claude; others unchanged). */
function presenceLabel(engine: string): string {
  return engine === 'claude-web' ? 'claude' : engine;
}

/**
 * Per-engine index presence — a DIFFERENT metric class from authority. A ✗ means
 * that engine's substrate hasn't indexed algovault.com, so a 0% mention there reads
 * "not indexed" (🔴 fix-now), NOT "not authoritative". Empty input → graceful
 * pre-first-probe state (no data yet). Reuses `shortEngine` for model→engine.
 */
export function computeIndexPresence(rows: IndexPresenceRow[]): IndexPresence {
  if (!rows || rows.length === 0) {
    return { engines: [], blocked: false, missing: [], hasData: false, line: 'no data yet — first probe Mon' };
  }
  const engines = rows
    .map((r) => {
      const engine = shortEngine(r.model);
      return { engine, present: !!r.present, substrate: ENGINE_SUBSTRATE[engine] ?? '' };
    })
    .sort((a, b) => {
      const ia = PRESENCE_ORDER.indexOf(a.engine);
      const ib = PRESENCE_ORDER.indexOf(b.engine);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  const missing = engines.filter((e) => !e.present).map((e) => presenceLabel(e.engine));
  const line = engines
    .map((e) => {
      const tick = e.present ? '✓' : '✗';
      const sub = e.substrate && e.substrate !== 'own' ? ` (${e.substrate})` : '';
      return `${presenceLabel(e.engine)} ${tick}${sub}`;
    })
    .join(' · ');
  return { engines, blocked: missing.length > 0, missing, hasData: true, line };
}

export interface EnginePlacement {
  query_id: string;
  /** competitor_name leading this query, or null = OPEN (no clear leader). */
  leader: string | null;
  domains: string[];
  citations: number;
}

export interface TopGapBrief {
  query_id: string;
  query_tier: string | null;
  recommended_action: string | null;
  top_competitor: string | null;
  top_competitor_domain: string | null;
}

/**
 * GEO-AUTOPILOT-W1 (C3) — the scored decision handoff (one per cycle). Built by the
 * cron from geo-decide's RankedDecision + geo-eligibility's look-alike suspects;
 * REPLACES the naive W4 "ONE MOVE" line. The cron persists the full decision to
 * `geo_decisions`; this is just the digest projection. Pure data — no Date / DB.
 */
export interface DecisionHandoff {
  priorityTier: 'eligibility' | 'third_party' | 'owned_content';
  /** e.g. "ELIGIBILITY (gate 1/3)". */
  gateLabel: string;
  move: string;
  /** drafted action-spec path (Q3 fast-path), when the objective maps the move. */
  knownActionSpec?: string;
  candidateCount: number;
  /** e.g. "geo-decision-2026-06-22" — Cowork materializes the vault file by this name. */
  briefName: string;
  /** look-alike domains cited but not ours (SUSPECT) — the digest watch line. */
  suspects: string[];
  /**
   * GEO-TARGET-DIGEST-REDESIGN-W1 (d) — the decision BASIS: the top-N ranked candidates + their
   * scores/tier/product-fit, so the chosen move is auditable ("why this, not that"). Projected from
   * the SAME `geo_decisions.ranked_candidates` the cron persists (single-derivation), NOT re-scored.
   */
  rankedCandidates?: RankedCandidateBrief[];
}

/** One ranked candidate as surfaced in the digest decision-basis (projection of a geo-decide Candidate). */
export interface RankedCandidateBrief {
  query_id: string | null;
  /** head/niche/branded (revenue_proximity tier). */
  query_tier: string | null;
  /** conversion tier ('A'|'B'|'contested') for the badge, from target_set. */
  target_tier?: string;
  move: string; // 'pursue_placement' | 'seed_the_answer' | 'earned' | engine/eligibility label
  expected_lift: number;
  product_fit: number;
  score: number;
}

// ── OPS-WEEKLY-GROWTH-DIGEST-W1: acquisition by source (folded in) ─────────────

/** One acquisition source's weekly stats (this week + last-week connects for WoW). */
export interface BySourceRow {
  source: string; // attribution slug (SoT: src/lib/attribution-sources.ts)
  connects: number; // distinct sessions, this week
  connectsLastWeek: number; // distinct sessions, prior week (for WoW)
  firstCall: number; // of this-week connects, that made >=1 tool call
  conversion: number; // of this-week connects, that reached a paid tier
}

/** Acquisition breakdown for the digest. `rows` is already capped (top 5 by connects). */
export interface BySourceData {
  rows: BySourceRow[];
  totalConnectsThisWeek: number;
  totalConnectsLastWeek: number;
  /** biggest WoW connect mover (by absolute delta), or null. */
  topMover: { source: string; from: number; to: number } | null;
  /** A4: best connect→CONVERSION source this week (value, not volume), or null when no conversions. */
  topConverter: { source: string; conversion: number; connects: number } | null;
}

export interface GeoDigestData {
  dateLabel: string; // e.g. "Mon 9 Jun" (cron-supplied; keeps this module Date-free)
  dashboardUrl: string;
  momentumDeltas: MomentumDeltas;
  /**
   * Per-engine named-in-answers + citation rate, this week. OPS-GEO-PROBE-MULTI-RUN-W1: the
   * cron projects this from the ONE shared `getQueryRates` (via `rollupByEngine`) — never an
   * inline per-model rate re-derivation. The optional fields (cited_count / total_runs / Wilson
   * CI / low_confidence) drive the "cited X/K = R% [CI]" line; absent (legacy/test callers) ⇒
   * only the mention-rate "Named in answers" line renders (back-compat).
   */
  perEngineMention: Array<{
    model: string;
    mention_rate_pct: number;
    cited_rate_pct: number;
    cited_count?: number;
    total_runs?: number;
    cited_rate_lo_pct?: number;
    cited_rate_hi_pct?: number;
    low_confidence?: boolean;
  }>;
  attributionGaps: AttributionGap[];
  contested: EnginePlacement[];
  topGap: TopGapBrief | null;
  /** R5 — per-engine index-presence (presence-tier probe; excluded from all authority aggregates). */
  indexPresence: IndexPresence;
  /** GEO-AUTOPILOT-W1 — the scored decision handoff; when set it REPLACES the ONE MOVE line. */
  decision?: DecisionHandoff | null;
  /**
   * GEO-AUTOPILOT-W1 fast-follow (2026-06-16) — eligibility is INDEX status, GSC-authoritative,
   * NOT the presence probe. `eligibilityNotIndexed` = substrates genuinely not indexed (the ONLY
   * 🔴 hard-banner trigger). `citationGapEngines` = engines indexed ✓ but un-retrieved (a soft
   * authority-gap note, never a re-crawl alarm — indexed != cited).
   */
  eligibilityNotIndexed?: string[];
  citationGapEngines?: string[];
  /**
   * OPS-WEEKLY-GROWTH-DIGEST-W1 — acquisition by source (connection-layer
   * `mcp_connect`, ATTRIBUTION-CONNECTION-SRC-W1). Folded into this digest (one
   * Monday operator message). `undefined` = section omitted (back-compat for
   * pre-W1 callers / tests); a provided value ALWAYS renders (incl. the empty
   * "attribution collecting" state). WoW is DB-derived (no state file).
   */
  bySource?: BySourceData | null;
  /**
   * GEO-TARGET-DIGEST-REDESIGN-W1 — the conversion-tier classification SoT (target_set from
   * geo-objective.yaml), threaded in by the cron. Drives the (e) Tier-A/B badges on who's-winning +
   * our-action. `undefined` ⇒ no badges (back-compat for pre-wave callers/tests).
   */
  targetSet?: TargetSet;
  /**
   * GEO-TARGET-DIGEST-REDESIGN-W1 (c) — per-target-query "our action" rows (posted/in-flight/none +
   * trend). `undefined` ⇒ section omitted (back-compat); a provided value always renders.
   */
  ourAction?: OurActionRow[] | null;
}

/**
 * OPS-WEEKLY-GROWTH-DIGEST-W1 — pure ACQUISITION section builder. `undefined`/null
 * → no section (back-compat). Empty (0 connects this week) → "attribution
 * collecting". Else: top sources by connects with WoW ↑/↓ + first-call + paid,
 * then the best CONVERTER (A4: value, not volume) + the biggest WoW mover.
 */
export function buildBySourceSection(b: BySourceData | null | undefined): string[] {
  if (b === undefined || b === null) return [];
  const L: string[] = ['', '*📈 ACQUISITION* (by source · vs last week)'];
  if (b.totalConnectsThisWeek === 0) {
    L.push(`• attribution collecting — ${b.totalConnectsThisWeek} connects captured this week so far`);
    return L;
  }
  for (const r of b.rows) {
    const arrow =
      r.connectsLastWeek === 0
        ? r.connects > 0
          ? 'new'
          : 'flat at 0'
        : r.connects > r.connectsLastWeek
          ? `↑ from ${r.connectsLastWeek}`
          : r.connects < r.connectsLastWeek
            ? `↓ from ${r.connectsLastWeek}`
            : `flat at ${r.connectsLastWeek}`;
    L.push(
      `• ${r.source}: ${r.connects} connect${r.connects === 1 ? '' : 's'} (${arrow}) · ${r.firstCall} first-call · ${r.conversion} paid`,
    );
  }
  if (b.topConverter) {
    const tc = b.topConverter;
    const rate = tc.connects > 0 ? Math.round((100 * tc.conversion) / tc.connects) : 0;
    L.push(
      `💰 Best converter: ${tc.source} — ${tc.conversion} paid from ${tc.connects} connect${tc.connects === 1 ? '' : 's'} (${rate}%)`,
    );
  } else {
    L.push('💰 Best converter: no conversions captured yet this week');
  }
  if (b.topMover) {
    const tm = b.topMover;
    const delta = tm.from === 0 ? 'new this week' : `${tm.to > tm.from ? '+' : ''}${tm.to - tm.from} (${tm.from}→${tm.to})`;
    L.push(`🚀 Biggest mover: ${tm.source} ${delta} connects`);
  }
  return L;
}

/**
 * R7 — assemble the full digest. PURE: derives momentum + attribution from the
 * same data so the header can't contradict the body. Section order:
 * verdict header → WHAT MOVED → DID LAST WEEK'S MOVE WORK → WHO'S WINNING → ONE MOVE → link.
 */
export function buildDigest(data: GeoDigestData): string[] {
  const m = computeMomentum(data.momentumDeltas);
  const attr = computeAttribution(data.attributionGaps);
  const d = data.momentumDeltas;
  const L: string[] = [];

  const ip = data.indexPresence;

  L.push(`📊 *GEO Weekly — ${data.dateLabel}*`);
  L.push('');
  L.push(`${m.emoji} *${m.headline}*`);

  // GEO-AUTOPILOT-W1 fast-follow (2026-06-16): eligibility = INDEX status, GSC-authoritative.
  // The 🔴 hard banner fires ONLY on an authoritatively NOT-INDEXED substrate (objective.
  // eligibility) — NOT on the LLM presence probe, which measures CITATION/retrieval and once
  // lagged a parking-snapshot cache → false "gemini not indexed". An indexed-but-un-retrieved
  // engine is a citation/authority gap, surfaced soft in WHAT MOVED below.
  const notIndexed = data.eligibilityNotIndexed ?? [];
  if (notIndexed.length > 0) {
    L.push('');
    L.push(`🔴 *BLOCKED ELIGIBILITY* — not indexed on ${notIndexed.join(', ')}. Fix the re-crawl before chasing authority.`);
  }

  // WHAT MOVED — leading indicators first
  L.push('');
  L.push('*WHAT MOVED* (vs last week)');
  L.push(`• Cited by engine: ${ip.line}`);
  // INDEXED != CITED — a ✗ above means "not yet cited" (authority gap), NOT "not indexed".
  const citationGaps = (data.citationGapEngines ?? []).filter((e) => !notIndexed.includes(e));
  if (citationGaps.length > 0) {
    L.push(`  ⓘ ${citationGaps.join(', ')}: indexed ✓ but not yet citing us — authority/content gap, not a re-crawl.`);
  }
  const citArrow =
    d.citationsThisWeek > d.citationsLastWeek
      ? `↑ from ${d.citationsLastWeek}`
      : d.citationsThisWeek < d.citationsLastWeek
        ? `↓ from ${d.citationsLastWeek}`
        : `flat at ${d.citationsLastWeek}`;
  L.push(`• Engine citations: ${d.citationsThisWeek} answer${d.citationsThisWeek === 1 ? '' : 's'} linked algovault.com (${citArrow})`);
  L.push(`• New trusted domains: ${d.newTrustedDomains.length ? `${d.newTrustedDomains.join(', ')} ✅` : 'none new this week'}`);
  const named = data.perEngineMention.filter((e) => e.mention_rate_pct > 0);
  if (data.perEngineMention.length === 0) {
    L.push('• Named in answers: no data yet — first probe Mon');
  } else if (named.length === 0) {
    L.push('• Named in answers: not yet named on any engine (pre-visibility)');
  } else {
    L.push(`• Named in answers: ${named.map((e) => `${Math.round(e.mention_rate_pct)}% on ${shortEngine(e.model)}`).join(', ')}`);
  }

  // OPS-GEO-PROBE-MULTI-RUN-W1 — per-engine CITATION RATE over K samples + 95% Wilson CI,
  // projected from the ONE shared getQueryRates (rollupByEngine). Makes a single week
  // trustworthy: "cited X/K = R% [lo–hi%]" with a low-confidence flag on partial-K engines (e.g.
  // gemini's frequent 429s → few successful samples → wide CI). Renders only when sample data is
  // present (total_runs); legacy/test callers without it keep the byte-stable mention-rate line.
  const withRate = data.perEngineMention.filter((e) => typeof e.total_runs === 'number' && e.total_runs > 0);
  if (withRate.length > 0) {
    L.push('• Cited rate (X of K samples · 95% CI):');
    for (const e of withRate) {
      const lo = Math.round(e.cited_rate_lo_pct ?? 0);
      const hi = Math.round(e.cited_rate_hi_pct ?? 0);
      const flag = e.low_confidence ? ' ⚠️ low-confidence' : '';
      L.push(
        `   – ${shortEngine(e.model)}: cited ${e.cited_count ?? 0}/${e.total_runs} = ${Math.round(e.cited_rate_pct)}% [${lo}–${hi}%]${flag}`,
      );
    }
  }

  // OPS-WEEKLY-GROWTH-DIGEST-W1: ACQUISITION by source (folded; renders only when
  // data.bySource is provided — undefined keeps the pre-W1 GEO digest byte-stable).
  for (const line of buildBySourceSection(data.bySource)) L.push(line);

  // DID LAST WEEK'S MOVE WORK? — the attribution loop
  L.push('');
  if (attr.length === 0) {
    L.push("*✅ DID LAST WEEK'S MOVE WORK?*");
    L.push('• No content moves are ≥7d old yet — first attribution next cycle.');
  } else {
    L.push("*DID LAST WEEK'S MOVE WORK?*");
    for (const a of attr) L.push(`${a.emoji} ${a.text}`);
  }

  // GEO-TARGET-DIGEST-REDESIGN-W1 (c) — per-target-query OUR ACTION status + trend (renders only
  // when the cron provides data.ourAction; undefined keeps pre-wave callers byte-stable).
  for (const line of buildOurActionSection(data.ourAction)) L.push(line);

  // WHO'S WINNING — competitor placement map, TARGET-ONLY (b: dropped misfits are filtered upstream
  // by the cron so vectorbt/backtrader stop showing every week) + each row badged by conversion tier (e).
  L.push('');
  L.push("*🥊 WHO'S WINNING WHAT WE WANT* (target queries only)");
  const ts = data.targetSet;
  const badgeFor = (qid: string): string => {
    const b = ts ? tierBadge(ts[qid]?.tier) : '';
    return b ? ` [${b}]` : '';
  };
  // (b) defense-in-depth: when the classification is present, only TARGET queries (A/B/contested)
  // render — a dropped misfit or measure_only probe can never reappear here even if upstream slips.
  const shownContested = ts
    ? data.contested.filter((c) => ts[c.query_id] && ts[c.query_id].tier !== 'measure_only')
    : data.contested;
  if (shownContested.length === 0) {
    L.push('• No competitor citations on a target query yet — every target is OPEN, your best shot.');
  } else {
    for (const c of shownContested) {
      if (!c.leader) {
        L.push(`• ${c.query_id}${badgeFor(c.query_id)} → no leader yet — OPEN, your best shot`);
      } else {
        const via = c.domains.slice(0, 2).join(' + ') || 'multiple sources';
        L.push(`• ${c.query_id}${badgeFor(c.query_id)} → ${c.leader}, cited via ${via} (${c.citations} citation${c.citations === 1 ? '' : 's'})`);
      }
    }
  }
  // (e) Keep the split visually honest: Tier-B citation volume is brand-presence, never pipeline.
  if (ts && Object.values(ts).some((t) => t.tier === 'B')) {
    L.push('  ⓘ 📣 brand-presence (Tier-B) = citations only — do NOT count as pipeline; 🎯 conversion (Tier-A) is where signups come from.');
  }

  // DECISION (GEO-AUTOPILOT-W1) — the scored, priority-gated handoff replaces the
  // naive W4 ONE MOVE when present; otherwise the ONE MOVE renders (additive,
  // backward-compatible). ONE operator-action block; no execution/completion TG.
  L.push('');
  if (data.decision) {
    const dec = data.decision;
    L.push('🎯 *DECISION READY* — open Cowork to act');
    L.push(`Priority: ${dec.gateLabel}  ·  Move: ${dec.move}`);
    if (dec.knownActionSpec) L.push(`candidate action: ${dec.knownActionSpec} (already drafted)`);
    L.push(
      `Brief: ${dec.briefName} · ${dec.candidateCount} candidate${dec.candidateCount === 1 ? '' : 's'} scored through the priority gate`,
    );
    // GEO-TARGET-DIGEST-REDESIGN-W1 (d) — the decision BASIS: top-N ranked candidates + scores so the
    // pick is auditable ("why this move, not that"). Projected from the SAME geo_decisions.ranked_
    // candidates the cron persists (single-derivation).
    if (dec.rankedCandidates && dec.rankedCandidates.length > 0) {
      L.push('Basis — ranked candidates (why this move):');
      dec.rankedCandidates.forEach((c, i) => {
        const badge = tierBadge(c.target_tier);
        const b = badge ? ` [${badge}]` : '';
        L.push(
          `  ${i + 1}. ${c.query_id ?? '—'}${b} · ${c.move} · score ${c.score.toFixed(2)} (lift ${c.expected_lift.toFixed(2)} · fit ${c.product_fit.toFixed(2)} · ${c.query_tier ?? '—'})`,
        );
      });
    }
    L.push('→ In Cowork: "write the GEO action from this week\'s brief" → research → approve → dispatch to Code');
    if (dec.suspects.length) {
      L.push(`⚠️ Look-alike watch: ${dec.suspects.join(', ')} cited but NOT ours (SUSPECT, not trusted).`);
    }
  } else {
    L.push("*🎯 THIS WEEK'S ONE MOVE* (auto-queued · 12h to veto)");
    if (!data.topGap) {
      L.push('• No move queued this week (no gap computed yet).');
    } else {
      const g = data.topGap;
      L.push(`${g.query_id}${g.query_tier ? ` (${g.query_tier})` : ''}: ${g.recommended_action ?? `low share-of-voice on ${g.query_id}`}`);
      if (g.top_competitor_domain) L.push(`→ Get AlgoVault a placement/answer on ${g.top_competitor_domain}.`);
    }
  }

  L.push('');
  L.push(`Full numbers ↗ ${data.dashboardUrl}?key=<admin-key>`);
  return L;
}
