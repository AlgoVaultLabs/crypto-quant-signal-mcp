/**
 * GEO-AUTOPILOT-W1 (C1) — the autopilot DECIDE scorer + decision-brief renderer.
 *
 * PURE: no DB, no Telegram, no LLM, no vault FS write. The in-container cron (C3)
 * owns persistence to `geo_decisions` + the digest; Cowork materializes the vault
 * `Prompt/geo-decision-<date>.md` FROM that table (the W2 Postgres-boundary pattern).
 * This module only reads the objective SoT (landing/Prompt/geo-objective.yaml) and
 * turns the week's probe signals into a priority-gated ranked decision + a brief.
 *
 * The HARD priority gate is the whole point: a genuinely NOT-INDEXED engine (GSC-authoritative
 * — indexing is the only true blocker) ALWAYS outranks third-party, which outranks owned-content.
 * INDEXED != CITED: an engine that IS indexed but doesn't cite us is an AUTHORITY gap (third_party
 * + owned), NOT an eligibility block — the LLM presence probe measures citation, never indexing
 * (it lagged + cached a parking snapshot → false "gemini not indexed"; corrected GEO-AUTOPILOT-W1
 * fast-follow 2026-06-16). Eligibility is GSC-authoritative via objective.eligibility.indexed_substrates.
 */
import * as yaml from 'js-yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type PriorityTier = 'eligibility' | 'third_party' | 'owned_content';

export interface ActionType {
  tier: number;
  channel: string;
  automatability: number;
  effort: number;
}

/** OPEN (no-leader) query handling — the "seed/own the definitive answer" move-type. */
export interface OpenQueryConfig {
  /** move label key for an uncontested query (e.g. 'seed_the_answer'). */
  move_type: string;
  /** an OPEN query with product_fit BELOW this is NOT promoted to a seed_the_answer move. */
  product_fit_threshold: number;
  /** expected_lift floor for an uncontested query — 0→cited on a no-leader query is the
   *  easiest win, so its lift defaults HIGH (never below open_bonus). */
  open_bonus: number;
}

/** GEO-TARGET-DIGEST-REDESIGN-W1 — a query's conversion classification (target_set SoT value). */
export type TargetTier = 'A' | 'B' | 'contested' | 'measure_only';
export type TargetMode = 'owned' | 'earned' | 'measure_only';
export interface TargetClassification {
  /** A = conversion (signups) · B = brand-presence (citations only) · contested = earned-only · measure_only = probe-only. */
  tier: TargetTier;
  /** ICP tier served (T1/T2/T3/ALL/META or a compound like "T2/T3") — display metadata, no code branch. */
  audience: string;
  /** owned = seed/own an answer · earned = press/Reddit/listicle only (never owned/placement) · measure_only = never a target. */
  target_mode: TargetMode;
}
export type TargetSet = Record<string, TargetClassification>;

export interface Objective {
  version: number;
  priority_gate: PriorityTier[];
  /** weight per query tier (head/niche/branded) — autopilot expected-value weight. */
  revenue_proximity: Record<string, number>;
  score_formula: string;
  action_types: Record<PriorityTier, ActionType>;
  /**
   * Per-query_id product-fit multiplier (0..1), sourced from brand-facts honest-scope:
   * "can AlgoVault CREDIBLY own this query?". Default (absent) = 1.0 (on-fit). Misfits
   * (e.g. best-python-backtester / python-quant-for-ai — AlgoVault is the signal layer a
   * backtest CALLS, never the backtester/framework) carry an explicit low value so the
   * scorer stops surfacing entrenched-but-unwinnable, off-product queries.
   */
  product_fit?: Record<string, number>;
  /**
   * GEO-TARGET-DIGEST-REDESIGN-W1 — the conversion-tiered TARGET SET (SoT). Per-query_id
   * classification the scorer's earned-routing AND the digest's Tier-A/B split both PROJECT
   * from (single-derivation). `contested` ⇒ `target_mode: 'earned'` ⇒ scoreWeek emits an
   * `earned` press/Reddit/listicle move, NEVER a competitor placement or an owned post.
   * Orthogonal to `revenue_proximity` (head/niche/branded). Absent id ⇒ treated as `owned`
   * (back-compat; a C3 canary asserts every live query is classified).
   */
  target_set?: TargetSet;
  /** OPEN (no-leader) query handling — emit `seed_the_answer` candidates for uncontested queries. */
  open_query?: OpenQueryConfig;
  /**
   * Autopub gate for the gap-persist→injector path (OPS-GEO-GAP-INJECTOR-PRODUCT-FIT-W1): a
   * persisted gap is `injectable` only if its product_fit ≥ this. INTENTIONALLY DISTINCT from
   * `open_query.product_fit_threshold` (which gates the SCORER surfacing a move to a human) —
   * autopub is higher-risk (auto-publishes behind only a 12h-veto), so its gate is independently
   * tunable and MUST stay ≥ the scorer threshold (autopub never looser than what we'd surface).
   */
  inject_threshold?: number;
  /** "<tier>:<engine-or-query_id>" -> drafted action-spec path (Q3 fast-path). */
  known_action_specs?: Record<string, string>;
  /**
   * GSC-authoritative index status — the engine retrieval SUBSTRATES we are indexed on
   * (Bing/Brave/Google/own). An engine whose substrate is NOT listed here is genuinely
   * not indexed (a real eligibility block). Default (absent) = all substrates indexed.
   * This is the ONLY index signal — the LLM presence probe (citation) never sets it.
   */
  eligibility?: { indexed_substrates: string[] };
  /**
   * OPS-GEO-PROBE-SIGNIFICANCE-GATE-W1 — alert-hygiene gate (resolved by
   * geo-alert-hygiene.ts::resolveAlertHygiene; shape matches AlertHygieneRaw). Static
   * policy config (no live numbers). Absent ⇒ DEFAULT_ALERT_HYGIENE (floor 5 / 0.20 / 2).
   */
  alert_hygiene?: {
    min_baseline_citations?: number;
    min_relative_drop?: number;
    consecutive_down_cycles?: number;
  };
  /**
   * OPS-GEO-PROBE-MULTI-RUN-W1 — weekly-probe sampling + pacing config (resolved by
   * geo-orchestrator.ts::resolveGeoProbe; shape matches GeoProbeRaw). Static policy config
   * (no live numbers). Absent ⇒ DEFAULT_GEO_PROBE (K=3 / concurrency 4 / 15s pacing). The
   * shape is inlined (not imported) to keep geo-decide a leaf — same pattern as alert_hygiene.
   */
  probe?: {
    runs_per_query?: number;
    runs_per_query_by_engine?: Record<string, number>;
    max_engine_concurrency?: number;
    inter_sample_delay_ms?: number;
    inter_sample_delay_ms_by_engine?: Record<string, number>;
    low_confidence_min_samples?: number;
  };
}

/** One per-query gap signal — a projection of geo-gap-list GapBrief / geo_mentions agg. */
export interface GapLike {
  query_id: string;
  query_tier: string; // head | niche | branded
  sov: number; // 0..1 share-of-voice
  top_competitor: string | null;
  top_competitor_domain: string | null;
}

/** The scorer's input — every field is derivable from the existing weekly probe. */
export interface ScoreInput {
  /**
   * Eligibility = INDEX/CRAWL status, GSC-AUTHORITATIVE. `notIndexed` = engines whose
   * substrate is genuinely NOT indexed (a real re-crawl blocker; the cron derives it from
   * objective.eligibility.indexed_substrates). An INDEXED-but-uncited engine is a
   * CITATION/authority gap (→ third_party/owned), never an eligibility block — so the LLM
   * retrieval-presence probe NEVER feeds this field (it measures citation, not indexing).
   */
  eligibility: { notIndexed: string[] };
  gaps: GapLike[];
}

export interface Candidate {
  tier: PriorityTier;
  key: string;
  label: string;
  query_id?: string;
  query_tier?: string;
  engine?: string;
  domain?: string;
  /**
   * third_party move subtype: 'pursue_placement' (a leader exists) · 'seed_the_answer' (OPEN, no
   * leader) · 'earned' (a CONTESTED/target_mode=earned query — draft press/Reddit/listicle, NEVER
   * a competitor placement or an owned post; GEO-TARGET-DIGEST-REDESIGN-W1).
   */
  move?: 'pursue_placement' | 'seed_the_answer' | 'earned';
  expected_lift: number;
  revenue_proximity: number;
  /** product-fit multiplier applied to the score (1.0 = on-fit; <1.0 = brand-facts honest-scope misfit). */
  product_fit: number;
  automatability: number;
  effort: number;
  score: number;
  known_action_spec?: string;
}

export interface RankedDecision {
  /** the highest unlocked priority tier (null only on a fully empty week). */
  priority_tier: PriorityTier | null;
  /** candidates in the active tier, score desc — the gate output. */
  ranked: Candidate[];
  chosen: Candidate | null;
  /** every candidate by tier (lower tiers are GATED behind the active one). */
  all: Record<PriorityTier, Candidate[]>;
}

/** Stable reach order for blocked engines (ChatGPT/Bing widest → Perplexity). */
const ENGINE_REACH = ['chatgpt', 'claude', 'gemini', 'perplexity'];

const TIER_LABEL: Record<PriorityTier, string> = {
  eligibility: 'ELIGIBILITY',
  third_party: 'THIRD-PARTY',
  owned_content: 'OWNED-CONTENT',
};

/**
 * Resolve + parse the objective SoT. Default path mirrors geo-orchestrator's
 * loadQueries: `landing/Prompt/geo-objective.yaml` (dist/lib → repo root → baked
 * into the image at Dockerfile `COPY landing/Prompt/`).
 */
export function loadObjective(yamlPath?: string): Objective {
  const resolved =
    yamlPath ?? path.resolve(__dirname, '..', '..', 'landing', 'Prompt', 'geo-objective.yaml');
  const obj = yaml.load(fs.readFileSync(resolved, 'utf-8')) as Objective;
  if (!obj || !Array.isArray(obj.priority_gate) || !obj.revenue_proximity || !obj.action_types) {
    throw new Error(
      `geo-objective.yaml at ${resolved} missing priority_gate / revenue_proximity / action_types`,
    );
  }
  return obj;
}

/** score within the unlocked tier — the documented form lives in geo-objective.yaml. */
function scoreOf(expectedLift: number, revenueProx: number, productFit: number, at: ActionType): number {
  return (expectedLift * revenueProx * productFit * at.automatability) / Math.max(at.effort, 0.01);
}

function revenueProximity(obj: Objective, tier: string): number {
  return obj.revenue_proximity[tier] ?? obj.revenue_proximity.niche ?? 0.5;
}

/**
 * Per-query product-fit (0..1) from the objective SoT; default 1.0 (on-fit) when unmapped.
 * EXPORTED as the single shared projection (OPS-GEO-GAP-INJECTOR-PRODUCT-FIT-W1): both the
 * scorer (scoreWeek) and the write-side (geo-gap-list persistGapBriefs) call THIS one fn, so
 * the persisted gap product_fit is byte-identical to the scorer's — the single-derivation canary.
 */
export function productFitOf(obj: Objective, query_id: string): number {
  const v = obj.product_fit?.[query_id];
  return typeof v === 'number' ? v : 1.0;
}

// GEO-TARGET-DIGEST-REDESIGN-W1 — the conversion classification is read directly from
// `obj.target_set?.[query_id]` at the ONE consumer (scoreWeek): a present target_set means a
// query absent from it is NOT a target (skipped), so a defaulting helper would MASK dropped-misfit
// leakage. The digest badges + cron read their own `target_set` map the same way.

/**
 * Rank the week's candidate moves through the HARD priority gate. PURE: same input +
 * objective ⇒ same decision. The active tier is the FIRST tier in `priority_gate`
 * with ≥1 candidate; ONLY its candidates appear in `ranked` (the gate). Lower-tier
 * candidates are retained in `all` for the brief but can never be `chosen`.
 */
export function scoreWeek(input: ScoreInput, obj: Objective): RankedDecision {
  const all: Record<PriorityTier, Candidate[]> = { eligibility: [], third_party: [], owned_content: [] };

  // ── eligibility tier: one candidate per GENUINELY NOT-INDEXED engine (GSC-authoritative,
  // NOT the LLM presence probe). Indexing is the only true blocker; an indexed-but-uncited
  // engine is authority work, handled by the third_party/owned tiers — never here. ──
  const atE = obj.action_types.eligibility;
  for (const engine of input.eligibility.notIndexed ?? []) {
    const key = `eligibility:${engine}`;
    all.eligibility.push({
      tier: 'eligibility',
      key,
      label: `${engine}'s substrate has NOT indexed algovault.com (GSC-authoritative) — fix the re-crawl/indexing before any authority work`,
      engine,
      expected_lift: 1.0, // unblocking an engine enables ALL citations on it
      revenue_proximity: 1.0,
      product_fit: 1.0, // unblocking an engine is product-agnostic
      automatability: atE.automatability,
      effort: atE.effort,
      score: scoreOf(1.0, 1.0, 1.0, atE),
      known_action_spec: obj.known_action_specs?.[key],
    });
  }

  // ── third-party + owned-content tiers, routed per gap by competitor presence ──
  // product_fit multiplies every score (brand-facts honest-scope): an entrenched-but-misfit
  // query (e.g. best-python-backtester — not a backtester) is demoted vs an on-fit query. An
  // OPEN (no-leader) query that clears product_fit_threshold becomes a SEED_THE_ANSWER move in
  // the same third_party tier (own the definitive answer), so the easiest, best-fit wins —
  // instead of being stranded in the gated owned_content tier behind a misfit placement.
  const atT = obj.action_types.third_party;
  const atO = obj.action_types.owned_content;
  for (const g of input.gaps ?? []) {
    const lift = Math.max(0, 1 - g.sov);
    const rp = revenueProximity(obj, g.query_tier);
    const pf = productFitOf(obj, g.query_id);
    // GEO-TARGET-DIGEST-REDESIGN-W1 — when a target_set SoT is present, ONLY classified TARGET queries
    // are scored: a query ABSENT from target_set (a dropped misfit whose historical data still lingers
    // in the 4-week gap window — e.g. best-python-backtester) OR a measure_only presence probe is
    // SKIPPED, never surfaced as a recommended move. The classification also gates the move-type BEFORE
    // the competitor-presence routing, so a contested query can never emit a competitor placement.
    // (target_set absent ⇒ back-compat: every gap routes as `owned`.)
    const classified = obj.target_set?.[g.query_id];
    if (obj.target_set && (!classified || classified.tier === 'measure_only' || classified.target_mode === 'measure_only')) {
      continue;
    }
    const targetMode = classified?.target_mode ?? 'owned';
    if (targetMode === 'earned') {
      // CONTESTED / earned-only → draft an EARNED placement (independent press / Reddit / listicle).
      // NEVER `pursue_placement` on the competitor's surface, NEVER an owned post — regardless of
      // whether a leader exists. No `domain` is attached, so no downstream render can turn this into
      // a "pursue a placement on <competitor>" suggestion (the wave's hard prohibition).
      const key = `third_party:${g.query_id}`;
      const leaderNote = g.top_competitor ? ` — ${g.top_competitor} currently leads` : '';
      all.third_party.push({
        tier: 'third_party',
        key,
        move: 'earned',
        label: `contested "${g.query_id}" (${g.query_tier})${leaderNote} — draft an EARNED placement (independent press / Reddit / third-party listicle); never an owned post or a placement on a competitor's site`,
        query_id: g.query_id,
        query_tier: g.query_tier,
        expected_lift: lift,
        revenue_proximity: rp,
        product_fit: pf,
        automatability: atT.automatability,
        effort: atT.effort,
        score: scoreOf(lift, rp, pf, atT),
        known_action_spec: obj.known_action_specs?.[key],
      });
      continue;
    }
    if (g.top_competitor_domain) {
      // a leader exists → pursue a placement on that surface (product_fit penalizes misfits).
      const key = `third_party:${g.query_id}`;
      all.third_party.push({
        tier: 'third_party',
        key,
        move: 'pursue_placement',
        label: `${g.top_competitor ?? 'a competitor'} leads "${g.query_id}" (${g.query_tier}) via ${g.top_competitor_domain} — pursue a placement on that surface`,
        query_id: g.query_id,
        query_tier: g.query_tier,
        domain: g.top_competitor_domain,
        expected_lift: lift,
        revenue_proximity: rp,
        product_fit: pf,
        automatability: atT.automatability,
        effort: atT.effort,
        score: scoreOf(lift, rp, pf, atT),
        known_action_spec: obj.known_action_specs?.[key],
      });
    } else if (obj.open_query && pf >= obj.open_query.product_fit_threshold) {
      // OPEN, no leader, on-fit → SEED the definitive third-party answer (the easiest win:
      // 0→cited on an uncontested query). expected_lift floors at open_bonus (defaults HIGH).
      const openLift = Math.max(lift, obj.open_query.open_bonus);
      const key = `third_party:${g.query_id}`;
      all.third_party.push({
        tier: 'third_party',
        key,
        move: 'seed_the_answer',
        label: `"${g.query_id}" (${g.query_tier}) is OPEN — no leader (SoV ${g.sov.toFixed(2)}) — seed/own the definitive third-party answer`,
        query_id: g.query_id,
        query_tier: g.query_tier,
        expected_lift: openLift,
        revenue_proximity: rp,
        product_fit: pf,
        automatability: atT.automatability,
        effort: atT.effort,
        score: scoreOf(openLift, rp, pf, atT),
        known_action_spec: obj.known_action_specs?.[key],
      });
    } else {
      // OPEN but BELOW product_fit_threshold (or no open_query config) → not a credible seed;
      // falls back to the gated owned_content tier.
      const key = `owned_content:${g.query_id}`;
      all.owned_content.push({
        tier: 'owned_content',
        key,
        label: `"${g.query_id}" (${g.query_tier}) is OPEN (SoV ${g.sov.toFixed(2)}) — publish/strengthen an owned answer page`,
        query_id: g.query_id,
        query_tier: g.query_tier,
        expected_lift: lift,
        revenue_proximity: rp,
        product_fit: pf,
        automatability: atO.automatability,
        effort: atO.effort,
        score: scoreOf(lift, rp, pf, atO),
        known_action_spec: obj.known_action_specs?.[key],
      });
    }
  }

  all.eligibility.sort(
    (a, b) => b.score - a.score || ENGINE_REACH.indexOf(a.engine!) - ENGINE_REACH.indexOf(b.engine!),
  );
  all.third_party.sort((a, b) => b.score - a.score);
  all.owned_content.sort((a, b) => b.score - a.score);

  // HARD gate: the active tier is the first in priority_gate order with candidates.
  let priority_tier: PriorityTier | null = null;
  for (const t of obj.priority_gate) {
    if (all[t].length > 0) {
      priority_tier = t;
      break;
    }
  }
  const ranked = priority_tier ? all[priority_tier] : [];
  return { priority_tier, ranked, chosen: ranked[0] ?? null, all };
}

/**
 * Render the weekly decision brief as a markdown STRING (NOT written to disk here —
 * the cron persists it to geo_decisions; Cowork materializes the vault file). Leads
 * with the gated priority tier, names the chosen move + any drafted spec, then the
 * ranked candidates, the gated tiers, the per-query gap table, and the Cowork
 * research scope.
 */
export function renderDecisionBrief(d: RankedDecision, gaps: GapLike[], dateLabel: string): string {
  const L: string[] = [];
  L.push(`# GEO decision brief — ${dateLabel}`);
  L.push('');

  if (!d.chosen || !d.priority_tier) {
    L.push('_No candidate move this week — no blocked engine, no contested query, no open gap._');
    L.push('');
    L.push('## Research scope for Cowork');
    L.push('- Nothing queued. Confirm the probe ran and review the dashboard for drift.');
    return L.join('\n');
  }

  const tier = d.priority_tier;
  L.push(`**Priority tier (gated):** ${TIER_LABEL[tier]} · **Move:** ${d.chosen.label}`);
  if (d.chosen.known_action_spec) {
    L.push(`candidate action: ${d.chosen.known_action_spec} (already drafted)`);
  }
  L.push('');

  L.push(`## Ranked candidates — ${TIER_LABEL[tier]} (top unlocked tier)`);
  L.push('| # | move | query | tier | lift | score |');
  L.push('|---|---|---|---|---|---|');
  d.ranked.forEach((c, i) => {
    const moveCell =
      c.engine ??
      c.domain ??
      (c.move === 'seed_the_answer' ? 'seed the answer' : c.move === 'earned' ? 'earned (press/Reddit/listicle)' : '—');
    L.push(
      `| ${i + 1} | ${moveCell} | ${c.query_id ?? '—'} | ${c.query_tier ?? '—'} | ${c.expected_lift.toFixed(2)} | ${c.score.toFixed(2)} |`,
    );
  });
  L.push('');

  const gated = (['eligibility', 'third_party', 'owned_content'] as PriorityTier[])
    .filter((t) => t !== tier && d.all[t].length > 0)
    .map((t) => `${TIER_LABEL[t].toLowerCase()}: ${d.all[t].length}`);
  if (gated.length) {
    L.push(`## Gated behind ${TIER_LABEL[tier]}`);
    L.push(`- ${gated.join(' · ')} (unlock after this tier clears — the gate is hard)`);
    L.push('');
  }

  if (gaps.length) {
    L.push('## Per-query gap table');
    L.push('| query | tier | SoV | leader | domain |');
    L.push('|---|---|---|---|---|');
    for (const g of gaps) {
      L.push(`| ${g.query_id} | ${g.query_tier} | ${g.sov.toFixed(2)} | ${g.top_competitor ?? '—'} | ${g.top_competitor_domain ?? 'OPEN'} |`);
    }
    L.push('');
  }

  L.push('## Research scope for Cowork');
  if (tier === 'eligibility') {
    L.push(`- Why is ${d.chosen.engine} not retrieving algovault.com? (index status, robots/sitemap, last crawl)`);
    L.push('- Concrete re-crawl move + expected lift (unblocking enables ALL citations on that engine).');
  } else if (tier === 'third_party') {
    if (d.chosen.move === 'seed_the_answer') {
      L.push(`- "${d.chosen.query_id}" has NO leader — what definitive third-party answer would own it? (0→cited on an uncontested query is the easiest win)`);
      L.push('- Concrete seed/own-the-answer move (dev.to/Medium answer post or owned page) + expected SoV lift + which sub-goal (A/B/C) it advances.');
    } else {
      L.push(`- Why does ${d.chosen.domain} win "${d.chosen.query_id}"? (page structure, proof, authority)`);
      L.push('- Concrete placement move + expected SoV lift + which sub-goal (A/B/C) it advances.');
    }
  } else {
    L.push(`- What answer/comparison content would win "${d.chosen.query_id}"?`);
    L.push('- Concrete owned-content move (Tier-1/2 Code spec) + expected lift + sub-goal.');
  }
  return L.join('\n');
}
