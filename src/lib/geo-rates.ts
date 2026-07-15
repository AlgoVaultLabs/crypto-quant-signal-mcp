/**
 * OPS-GEO-PROBE-MULTI-RUN-W1 (C2) — the ONE place a per-(query,engine) citation/mention RATE
 * + confidence interval is derived. SINGLE-DERIVATION (CLAUDE.md LAW): the digest per-engine
 * "cited X/K = R% [CI]" line AND the scorer's share-of-voice (geo-gap-list::computeGapList →
 * geo-decide::scoreWeek expected_lift) BOTH project from `getQueryRates` — neither re-derives a
 * rate inline. So a single week is trustworthy (a denoised rate + an honest CI width) instead of
 * an engine non-determinism coin-flip (LLM retrieval ~16% noise floor).
 *
 * Why a RATE + Wilson CI (not a raw single sample): each (query,engine) is sampled K times/cycle
 * (geo-orchestrator). `cited` is DETERMINISTIC per sample (any returned citation URL on
 * algovault.com → true; geo-extractor::deriveCited), so cited_count/total_runs is a clean
 * binomial proportion. Error samples are NOT written to geo_mentions (geo-storage::recordGeoRun
 * skips them), so `total_runs` here = SUCCESSFUL samples → the denominator is honest and a cell
 * with few successes (e.g. gemini's frequent 429s) reads as partial-K low_confidence + a WIDE
 * Wilson interval, never a precise-but-wrong low rate.
 *
 * PURE leaf (the only DB-touching fn is getQueryRates); computeRates / rollupByEngine /
 * wilsonInterval are pure + unit-tested (geo-rates.test.ts). Mirrors geo-alert-hygiene's shape.
 *
 * Forward note (NOT this wave): once these CIs exist, the significance gate
 * (geo-alert-hygiene::isSignificantDecline) MAY relax consecutive_down_cycles 2→1 and compare
 * NON-OVERLAPPING CIs — a follow-up. This wave only PRODUCES the rate+CI; the alarm gate is
 * unchanged (it still keys on the aggregate cited-count history, which excludes these error rows
 * by construction — error rows are cited=false, never counted).
 */
import { dbQuery } from './performance-db.js';

/** Default low-confidence sample floor when a caller doesn't supply the probe config value. */
export const DEFAULT_LOW_CONFIDENCE_MIN_SAMPLES = 3;

/** z for a 95% two-sided interval (standard-normal quantile). */
const Z_95 = 1.959963984540054;

/**
 * Wilson score interval for a binomial proportion (`k` successes of `n` trials). Better than the
 * naive normal interval at small n / extreme p (it never escapes [0,1] and is defined at p=0/1).
 * n<=0 ⇒ {0,0} (no data). Pure + deterministic.
 */
export function wilsonInterval(k: number, n: number, z: number = Z_95): { lo: number; hi: number } {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0) return { lo: 0, hi: 0 };
  const kk = Math.max(0, Math.min(k, n));
  const p = kk / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    lo: Math.max(0, (center - margin) / denom),
    hi: Math.min(1, (center + margin) / denom),
  };
}

/** Raw per-(query,engine) cell from geo_mentions (successful samples only — errors aren't written). */
export interface RateRow {
  query_id: string;
  query_tier: string | null;
  model: string;
  total_runs: number | string;
  cited_count: number | string;
  mention_count: number | string;
  avg_sov: number | string | null;
}

/** Per-(query,engine) denoised rate + Wilson CI + low-confidence flag. */
export interface QueryEngineRate {
  query_id: string;
  query_tier: string | null;
  model: string;
  total_runs: number; // SUCCESSFUL samples in the window (== K when none errored)
  cited_count: number;
  cited_rate: number; // 0..1
  cited_rate_lo: number; // Wilson lower bound (0..1)
  cited_rate_hi: number; // Wilson upper bound (0..1)
  mention_count: number;
  mention_rate: number; // 0..1
  avg_sov: number; // mean share_of_voice over the window (0..1)
  low_confidence: boolean; // total_runs < lowConfidenceMinSamples
}

function n(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const x = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(x) ? x : 0;
}

/**
 * Pure: raw cells → per-(query,engine) rate + Wilson CI + low_confidence. Same input ⇒ same
 * output. `lowConfidenceMinSamples` is the SUCCESSFUL-sample floor below which the cell is flagged
 * low_confidence (a cell with K=1 legacy sample, or a partial-K engine, reads honest + wide-CI).
 */
export function computeRates(
  rows: RateRow[],
  lowConfidenceMinSamples: number = DEFAULT_LOW_CONFIDENCE_MIN_SAMPLES,
): QueryEngineRate[] {
  const floor = Math.max(1, Math.floor(lowConfidenceMinSamples) || DEFAULT_LOW_CONFIDENCE_MIN_SAMPLES);
  return rows.map((r) => {
    const total = Math.max(0, n(r.total_runs));
    const cited = Math.max(0, Math.min(n(r.cited_count), total));
    const mention = Math.max(0, Math.min(n(r.mention_count), total));
    const ci = wilsonInterval(cited, total);
    return {
      query_id: r.query_id,
      query_tier: r.query_tier ?? null,
      model: r.model,
      total_runs: total,
      cited_count: cited,
      cited_rate: total > 0 ? cited / total : 0,
      cited_rate_lo: ci.lo,
      cited_rate_hi: ci.hi,
      mention_count: mention,
      mention_rate: total > 0 ? mention / total : 0,
      avg_sov: Math.max(0, Math.min(1, n(r.avg_sov))),
      low_confidence: total < floor,
    };
  });
}

/** Per-engine pooled rate (sum cells across queries) + pooled Wilson CI + low_confidence. */
export interface EngineRate {
  model: string;
  query_count: number;
  total_runs: number;
  cited_count: number;
  cited_rate: number;
  cited_rate_lo: number;
  cited_rate_hi: number;
  mention_count: number;
  mention_rate: number;
  avg_sov: number; // sample-weighted mean of per-cell avg_sov
  low_confidence: boolean; // pooled total_runs < floor
}

/**
 * Pool the per-(query,engine) rates UP to per-engine (sum across queries) with a pooled Wilson
 * CI. The digest's per-engine "Named in answers / cited X/K [CI]" projects from THIS — so the
 * digest never re-derives the per-engine rate inline. avg_sov pools sample-weighted (each cell
 * weighted by its successful-sample count). Sorted by model for deterministic rendering.
 */
export function rollupByEngine(
  rates: QueryEngineRate[],
  lowConfidenceMinSamples: number = DEFAULT_LOW_CONFIDENCE_MIN_SAMPLES,
): EngineRate[] {
  const floor = Math.max(1, Math.floor(lowConfidenceMinSamples) || DEFAULT_LOW_CONFIDENCE_MIN_SAMPLES);
  const byModel = new Map<string, QueryEngineRate[]>();
  for (const r of rates) {
    const arr = byModel.get(r.model);
    if (arr) arr.push(r);
    else byModel.set(r.model, [r]);
  }
  const out: EngineRate[] = [];
  for (const [model, cells] of byModel) {
    const total = cells.reduce((s, c) => s + c.total_runs, 0);
    const cited = cells.reduce((s, c) => s + c.cited_count, 0);
    const mention = cells.reduce((s, c) => s + c.mention_count, 0);
    const sovWeighted = cells.reduce((s, c) => s + c.avg_sov * c.total_runs, 0);
    const ci = wilsonInterval(cited, total);
    out.push({
      model,
      query_count: cells.length,
      total_runs: total,
      cited_count: cited,
      cited_rate: total > 0 ? cited / total : 0,
      cited_rate_lo: ci.lo,
      cited_rate_hi: ci.hi,
      mention_count: mention,
      mention_rate: total > 0 ? mention / total : 0,
      avg_sov: total > 0 ? sovWeighted / total : 0,
      low_confidence: total < floor,
    });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * Per-(query,engine) rate aggregation SQL over a rolling window of `$1` weeks. Retrieval rows
 * only, presence-tier excluded — matches every other authority aggregate (gap-list, dashboard,
 * digest deltas). total_runs counts geo_mentions rows = SUCCESSFUL samples (errors aren't written).
 */
export const QUERY_RATES_SQL = `
  SELECT query_id,
         max(query_tier) AS query_tier,
         model,
         count(*) AS total_runs,
         count(*) FILTER (WHERE cited) AS cited_count,
         count(*) FILTER (WHERE mention_found) AS mention_count,
         AVG(share_of_voice) AS avg_sov
  FROM geo_mentions
  WHERE retrieval = true AND ran_at > now() - make_interval(weeks => $1)
    AND query_tier IS DISTINCT FROM 'presence'
  GROUP BY query_id, model
`;

/**
 * THE shared read: per-(query,engine) citation/mention rate + Wilson CI + low_confidence over the
 * last `windowWeeks` weeks. Fail-open ([]). Consumers: the digest (via rollupByEngine) + the
 * scorer (via computeGapList). Never re-derive these rates inline elsewhere.
 */
export async function getQueryRates(
  windowWeeks: number,
  lowConfidenceMinSamples: number = DEFAULT_LOW_CONFIDENCE_MIN_SAMPLES,
): Promise<QueryEngineRate[]> {
  try {
    const rows = await dbQuery<RateRow>(QUERY_RATES_SQL, [windowWeeks]);
    return computeRates(rows, lowConfidenceMinSamples);
  } catch (err) {
    console.error(
      `[geo-rates] getQueryRates failed (fail-open []): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

// ── GEO-TARGET-DIGEST-REDESIGN-W1 — per-QUERY projections (pool across engines) ──────────────
// The digest's target-only "who's-winning" trend + the per-query "our action" line need a
// per-query (engine-pooled) rate; the full-funnel attribution needs a before/after per-query rate
// DELTA. Both PROJECT from the SAME denoised source (computeRates output / the shared wilsonInterval)
// — no inline Wilson/rate re-derivation (CLAUDE.md single-derivation LAW).

/** Per-query pooled rate (sum cells across engines) + pooled Wilson CI + low_confidence. */
export interface QueryRate {
  query_id: string;
  query_tier: string | null;
  engine_count: number;
  total_runs: number;
  cited_count: number;
  cited_rate: number;
  cited_rate_lo: number;
  cited_rate_hi: number;
  mention_count: number;
  mention_rate: number;
  mention_rate_lo: number;
  mention_rate_hi: number;
  avg_sov: number; // sample-weighted mean of per-cell avg_sov
  low_confidence: boolean;
}

/**
 * Pool the per-(query,engine) rates UP to per-QUERY (sum across engines) with pooled Wilson CIs on
 * BOTH cited and mention. Mirrors `rollupByEngine` but keyed by query_id — the digest's who's-winning
 * trend + our-action line project from THIS, never an inline per-query rate. Sorted by query_id.
 */
export function rollupByQuery(
  rates: QueryEngineRate[],
  lowConfidenceMinSamples: number = DEFAULT_LOW_CONFIDENCE_MIN_SAMPLES,
): QueryRate[] {
  const floor = Math.max(1, Math.floor(lowConfidenceMinSamples) || DEFAULT_LOW_CONFIDENCE_MIN_SAMPLES);
  const byQuery = new Map<string, QueryEngineRate[]>();
  for (const r of rates) {
    const arr = byQuery.get(r.query_id);
    if (arr) arr.push(r);
    else byQuery.set(r.query_id, [r]);
  }
  const out: QueryRate[] = [];
  for (const [query_id, cells] of byQuery) {
    const total = cells.reduce((s, c) => s + c.total_runs, 0);
    const cited = cells.reduce((s, c) => s + c.cited_count, 0);
    const mention = cells.reduce((s, c) => s + c.mention_count, 0);
    const sovWeighted = cells.reduce((s, c) => s + c.avg_sov * c.total_runs, 0);
    const citedCi = wilsonInterval(cited, total);
    const mentionCi = wilsonInterval(mention, total);
    out.push({
      query_id,
      query_tier: cells[0]?.query_tier ?? null,
      engine_count: cells.length,
      total_runs: total,
      cited_count: cited,
      cited_rate: total > 0 ? cited / total : 0,
      cited_rate_lo: citedCi.lo,
      cited_rate_hi: citedCi.hi,
      mention_count: mention,
      mention_rate: total > 0 ? mention / total : 0,
      mention_rate_lo: mentionCi.lo,
      mention_rate_hi: mentionCi.hi,
      avg_sov: total > 0 ? sovWeighted / total : 0,
      low_confidence: total < floor,
    });
  }
  return out.sort((a, b) => a.query_id.localeCompare(b.query_id));
}

/** Raw before/after aggregate for one acted-on query (engine-pooled; retrieval+non-presence only). */
export interface AttributionAgg {
  query_id: string;
  runs_before: number | string;
  cited_before: number | string;
  mention_before: number | string;
  sov_before: number | string | null;
  runs_after: number | string;
  cited_after: number | string;
  mention_after: number | string;
  sov_after: number | string | null;
}

/** One side (before | after the move) — rate + Wilson CI on both cited and mention. */
export interface AttributionSide {
  total_runs: number;
  cited_rate: number;
  cited_rate_lo: number;
  cited_rate_hi: number;
  mention_rate: number;
  mention_rate_lo: number;
  mention_rate_hi: number;
  avg_sov: number;
  low_confidence: boolean;
}

/** Per-query full-funnel attribution: before/after rate sides + the mention/cited/SoV deltas. */
export interface QueryAttributionRate {
  query_id: string;
  before: AttributionSide;
  after: AttributionSide;
  /** after − before, RATE points (0..1). Leading indicator = mention. */
  mention_delta: number;
  cited_delta: number;
  sov_delta: number;
}

function attributionSide(
  runs: number,
  cited: number,
  mention: number,
  sov: number,
  floor: number,
): AttributionSide {
  const total = Math.max(0, runs);
  const c = Math.max(0, Math.min(cited, total));
  const m = Math.max(0, Math.min(mention, total));
  const cci = wilsonInterval(c, total);
  const mci = wilsonInterval(m, total);
  return {
    total_runs: total,
    cited_rate: total > 0 ? c / total : 0,
    cited_rate_lo: cci.lo,
    cited_rate_hi: cci.hi,
    mention_rate: total > 0 ? m / total : 0,
    mention_rate_lo: mci.lo,
    mention_rate_hi: mci.hi,
    avg_sov: Math.max(0, Math.min(1, sov)),
    low_confidence: total < floor,
  };
}

/**
 * Pure: raw before/after aggregates → per-query mention/cited/SoV rate deltas + Wilson CIs. Reuses
 * the SHARED `wilsonInterval` (never a fresh CI/rate formula) — the same math behind getQueryRates.
 * The digest verdict ("a move works if it lifts the LEADING indicator — mention — even while cited
 * is flat") is applied in geo-digest.ts::computeAttribution over this output. Same input ⇒ same output.
 */
export function computeAttributionRates(
  rows: AttributionAgg[],
  lowConfidenceMinSamples: number = DEFAULT_LOW_CONFIDENCE_MIN_SAMPLES,
): QueryAttributionRate[] {
  const floor = Math.max(1, Math.floor(lowConfidenceMinSamples) || DEFAULT_LOW_CONFIDENCE_MIN_SAMPLES);
  return rows.map((r) => {
    const before = attributionSide(n(r.runs_before), n(r.cited_before), n(r.mention_before), n(r.sov_before), floor);
    const after = attributionSide(n(r.runs_after), n(r.cited_after), n(r.mention_after), n(r.sov_after), floor);
    return {
      query_id: r.query_id,
      before,
      after,
      mention_delta: after.mention_rate - before.mention_rate,
      cited_delta: after.cited_rate - before.cited_rate,
      sov_delta: after.avg_sov - before.avg_sov,
    };
  });
}
