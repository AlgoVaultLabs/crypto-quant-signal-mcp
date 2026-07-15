/**
 * GEO-AUTOPILOT-W1 (C1) — geo-decide unit tests (test-first).
 *
 * The scorer ranks the week's candidate moves through the HARD priority gate
 * (eligibility → third-party → owned-content) and renders the decision brief.
 *
 * Invariants under test:
 *   - PRIORITY GATE IS HARD: a genuinely NOT-INDEXED engine (GSC-authoritative, from
 *     objective.eligibility.indexed_substrates) ALWAYS outranks any owned move (central AC).
 *   - INDEXED != CITED (fast-follow 2026-06-16): a presence-probe miss while INDEXED is a
 *     citation/authority gap (→ third_party/owned), NOT an eligibility block — the
 *     eligibility tier fires ONLY from `notIndexed`, never from the LLM presence probe.
 *   - within the top unlocked tier, score = lift × revenue_proximity ×
 *     automatability ÷ effort, ordered desc; branded(0.8) > niche(0.6).
 *   - chosen move carries its drafted action spec when the objective maps it.
 *   - renderDecisionBrief emits a valid brief (sections + candidate-action line)
 *     and degrades gracefully on an empty week.
 *   - loadObjective parses the real landing/Prompt/geo-objective.yaml + the
 *     ratified weights / gate order, with zero hardcoded live numbers.
 */
import { describe, it, expect } from 'vitest';
import {
  scoreWeek,
  renderDecisionBrief,
  loadObjective,
  type Objective,
  type ScoreInput,
} from '../../src/lib/geo-decide.js';
// GEO-TARGET-DIGEST-REDESIGN-W1 — the target_set coverage canary cross-checks against the live query set.
import { loadQueries } from '../../src/lib/geo-orchestrator.js';

// Fixture objective — mirrors the ratified landing/Prompt/geo-objective.yaml.
const OBJ: Objective = {
  version: 1,
  priority_gate: ['eligibility', 'third_party', 'owned_content'],
  revenue_proximity: { head: 1.0, branded: 0.8, niche: 0.6 },
  score_formula: 'expected_lift * revenue_proximity * product_fit * automatability / effort',
  action_types: {
    eligibility: { tier: 1, channel: 'deterministic_or_operator', automatability: 0.9, effort: 0.3 },
    third_party: { tier: 2, channel: 'draft_for_operator', automatability: 0.4, effort: 0.6 },
    owned_content: { tier: 3, channel: 'cowork_authored_code_wave', automatability: 0.7, effort: 1.0 },
  },
  // product-fit map (brand-facts honest-scope): AlgoVault is the verifiable call/signal-
  // interpretation layer, NOT a backtester / full quant framework → those queries are misfits.
  product_fit: { 'best-python-backtester': 0.15, 'python-quant-for-ai': 0.2 },
  // OPEN (no-leader) query handling: an uncontested query with product_fit ≥ threshold is
  // scoreable as a seed_the_answer move (own the definitive third-party answer) with a high lift.
  open_query: { move_type: 'seed_the_answer', product_fit_threshold: 0.5, open_bonus: 0.9 },
  known_action_specs: { 'eligibility:gemini': 'Prompt/fix-gemini-google-index-presence-w1.md' },
};

/**
 * An OPEN head gap with maximal lift (sov 0), ON-FIT (product_fit default 1.0) → now a
 * third_party seed_the_answer move (GEO-OBJECTIVE-PRODUCT-FIT-OPEN-QUERY-FIX-W1; was owned_content).
 */
const OPEN_HEAD_GAP = {
  query_id: 'best-mcp-trading',
  query_tier: 'head',
  sov: 0,
  top_competitor: null,
  top_competitor_domain: null,
};

/**
 * An OPEN head gap that is BELOW the product_fit threshold (python-quant-for-ai → 0.2) → it is
 * NOT promoted to a seed; it falls to the gated owned_content tier. The owned-content tempter.
 */
const OWNED_FALLBACK_GAP = {
  query_id: 'python-quant-for-ai',
  query_tier: 'head',
  sov: 0,
  top_competitor: null,
  top_competitor_domain: null,
};

describe('scoreWeek — HARD priority gate', () => {
  it('a genuinely NOT-INDEXED engine (GSC-authoritative) ALWAYS outranks any lower-tier (seed/owned) move', () => {
    const input: ScoreInput = {
      eligibility: { notIndexed: ['gemini'] }, // a REAL index block (substrate absent from the GSC SoT)
      // high-scoring lower-tier moves on their own: an on-fit OPEN seed (third_party) + an off-fit owned move…
      gaps: [OPEN_HEAD_GAP, OWNED_FALLBACK_GAP],
    };
    const d = scoreWeek(input, OBJ);

    expect(d.priority_tier).toBe('eligibility');
    expect(d.chosen?.tier).toBe('eligibility');
    expect(d.chosen?.engine).toBe('gemini');
    // …but BOTH are GATED: ranked holds only the active tier; the lower-tier moves exist but are excluded.
    expect(d.ranked.every((c) => c.tier === 'eligibility')).toBe(true);
    expect(d.all.third_party.length).toBeGreaterThan(0); // the on-fit OPEN seed
    expect(d.all.owned_content.length).toBeGreaterThan(0); // the off-fit owned move
    expect(d.ranked.some((c) => c.tier !== 'eligibility')).toBe(false);
  });

  it('with no engine blocked, third-party leads and owned-content is gated below', () => {
    const input: ScoreInput = {
      eligibility: { notIndexed: [] },
      gaps: [
        { query_id: 'best-mcp-trading', query_tier: 'head', sov: 0.1, top_competitor: 'altfins', top_competitor_domain: 'altfins.com' },
        OWNED_FALLBACK_GAP, // off-fit OPEN query → owned-content tempter, gated below
      ],
    };
    const d = scoreWeek(input, OBJ);

    expect(d.priority_tier).toBe('third_party');
    expect(d.chosen?.tier).toBe('third_party');
    expect(d.chosen?.domain).toBe('altfins.com');
    expect(d.ranked.every((c) => c.tier === 'third_party')).toBe(true);
    expect(d.all.owned_content.length).toBeGreaterThan(0);
  });

  it('with no eligibility block and a no-leader BELOW-fit query, owned-content is the tier', () => {
    // An on-fit OPEN query now seeds the answer in third_party; only a BELOW-fit OPEN query
    // (python-quant-for-ai 0.2 < threshold) falls to the owned_content tier.
    const input: ScoreInput = {
      eligibility: { notIndexed: [] },
      gaps: [OWNED_FALLBACK_GAP],
    };
    const d = scoreWeek(input, OBJ);
    expect(d.priority_tier).toBe('owned_content');
    expect(d.chosen?.tier).toBe('owned_content');
  });

  it('REGRESSION (indexed != cited): un-retrieved-but-INDEXED engine → NOT eligibility, routes to authority work', () => {
    // The live state the fast-follow corrects: GSC confirms algovault.com is indexed on ALL
    // substrates (gemini/Google included) → notIndexed=[]. The presence probe showing gemini
    // 0% retrieval is a CITATION gap, NOT an index block — it must NOT surface "fix re-crawl".
    const d = scoreWeek(
      {
        eligibility: { notIndexed: [] }, // GSC-authoritative: everything indexed
        gaps: [{ query_id: 'best-mcp-trading', query_tier: 'head', sov: 0.1, top_competitor: 'altfins', top_competitor_domain: 'altfins.com' }],
      },
      OBJ,
    );
    expect(d.priority_tier).not.toBe('eligibility'); // the core correction
    expect(d.chosen?.tier).toBe('third_party');
    expect(d.all.eligibility.length).toBe(0);
  });
});

describe('scoreWeek — within-tier scoring', () => {
  it('orders by revenue_proximity at equal lift: head > branded > niche', () => {
    const input: ScoreInput = {
      eligibility: { notIndexed: [] },
      gaps: [
        { query_id: 'cross-venue-funding', query_tier: 'niche', sov: 0.2, top_competitor: 'coinglass', top_competitor_domain: 'coinglass.com' },
        { query_id: 'composite-quant-signal', query_tier: 'branded', sov: 0.2, top_competitor: 'messari', top_competitor_domain: 'messari.io' },
        { query_id: 'best-mcp-trading', query_tier: 'head', sov: 0.2, top_competitor: 'altfins', top_competitor_domain: 'altfins.com' },
      ],
    };
    const d = scoreWeek(input, OBJ);
    expect(d.ranked.map((c) => c.query_tier)).toEqual(['head', 'branded', 'niche']);
    // branded (0.8) must beat niche (0.6) — the ratified weight lift.
    const branded = d.ranked.find((c) => c.query_tier === 'branded')!;
    const niche = d.ranked.find((c) => c.query_tier === 'niche')!;
    expect(branded.score).toBeGreaterThan(niche.score);
  });

  it('chosen move carries its drafted action spec when the objective maps it', () => {
    const d = scoreWeek({ eligibility: { notIndexed: ['gemini'] }, gaps: [] }, OBJ);
    expect(d.chosen?.known_action_spec).toBe('Prompt/fix-gemini-google-index-presence-w1.md');
  });

  it('empty week → no candidate, no throw', () => {
    const d = scoreWeek({ eligibility: { notIndexed: [] }, gaps: [] }, OBJ);
    expect(d.chosen).toBeNull();
    expect(d.ranked).toEqual([]);
  });
});

describe('scoreWeek — product_fit + OPEN-query seed_the_answer (GEO-OBJECTIVE-PRODUCT-FIT-OPEN-QUERY-FIX-W1)', () => {
  // The misfit leader: entrenched (vectorbt leads), but AlgoVault is not a backtester (product_fit 0.15).
  const MISFIT_LEADER = {
    query_id: 'best-python-backtester',
    query_tier: 'head',
    sov: 0,
    top_competitor: 'vectorbt',
    top_competitor_domain: 'vectorbt.dev',
  };
  // The OPEN-fit best-shot: no leader, perfect product fit (default 1.0).
  const OPEN_FIT = {
    query_id: 'ai-agent-trade-signals',
    query_tier: 'head',
    sov: 0,
    top_competitor: null,
    top_competitor_domain: null,
  };

  it('REGRESSION: an entrenched-but-misfit head query never outranks an OPEN-fit head query', () => {
    const d = scoreWeek({ eligibility: { notIndexed: [] }, gaps: [MISFIT_LEADER, OPEN_FIT] }, OBJ);
    // both compete in the SAME unlocked tier (third_party) — the OPEN-fit query wins.
    expect(d.priority_tier).toBe('third_party');
    expect(d.chosen?.query_id).toBe('ai-agent-trade-signals');
    const fitIdx = d.ranked.findIndex((c) => c.query_id === 'ai-agent-trade-signals');
    const misfitIdx = d.ranked.findIndex((c) => c.query_id === 'best-python-backtester');
    expect(fitIdx).toBeGreaterThanOrEqual(0);
    expect(misfitIdx).toBeGreaterThan(fitIdx); // misfit STRICTLY below the OPEN-fit move
  });

  it('an OPEN no-leader on-fit query produces a seed_the_answer third-party candidate (it produced none before)', () => {
    const d = scoreWeek({ eligibility: { notIndexed: [] }, gaps: [OPEN_FIT] }, OBJ);
    expect(d.priority_tier).toBe('third_party');
    const seed = d.all.third_party.find((c) => c.query_id === 'ai-agent-trade-signals');
    expect(seed).toBeDefined();
    expect(seed?.move).toBe('seed_the_answer');
    expect(seed?.domain).toBeUndefined(); // no leader to "pursue a placement on"
    expect(seed?.label.toLowerCase()).toContain('seed');
  });

  it('product_fit multiplies into the score: a misfit scores below the same-tier full-fit query', () => {
    const dMisfit = scoreWeek({ eligibility: { notIndexed: [] }, gaps: [MISFIT_LEADER] }, OBJ);
    const onFitLeader = { ...MISFIT_LEADER, query_id: 'best-mcp-trading', top_competitor_domain: 'altfins.com' };
    const dOnFit = scoreWeek({ eligibility: { notIndexed: [] }, gaps: [onFitLeader] }, OBJ);
    expect(dMisfit.chosen?.product_fit).toBeCloseTo(0.15);
    expect(dOnFit.chosen?.product_fit).toBeCloseTo(1.0);
    // identical inputs except product_fit → the misfit must score strictly lower.
    expect(dOnFit.chosen!.score).toBeGreaterThan(dMisfit.chosen!.score);
  });

  it('the HARD priority gate is unchanged: a NOT-INDEXED engine still outranks every seed/placement', () => {
    const d = scoreWeek({ eligibility: { notIndexed: ['gemini'] }, gaps: [OPEN_FIT, MISFIT_LEADER] }, OBJ);
    expect(d.priority_tier).toBe('eligibility');
    expect(d.chosen?.tier).toBe('eligibility');
    expect(d.ranked.every((c) => c.tier === 'eligibility')).toBe(true);
    expect(d.all.third_party.length).toBeGreaterThan(0); // the seed + placement exist but are GATED
  });

  it('an OPEN query BELOW the product_fit threshold is NOT promoted to seed_the_answer (stays gated owned-content)', () => {
    // best-python-backtester as an OPEN query (no leader) — but product_fit 0.15 < threshold 0.5.
    const openMisfit = { ...MISFIT_LEADER, top_competitor: null, top_competitor_domain: null };
    const d = scoreWeek({ eligibility: { notIndexed: [] }, gaps: [openMisfit] }, OBJ);
    expect(d.all.third_party.find((c) => c.query_id === 'best-python-backtester')).toBeUndefined();
    const owned = d.all.owned_content.find((c) => c.query_id === 'best-python-backtester');
    expect(owned).toBeDefined();
    expect(owned?.product_fit).toBeCloseTo(0.15);
    expect(d.priority_tier).toBe('owned_content');
  });
});

describe('renderDecisionBrief', () => {
  it('renders a valid brief with the move, candidate-action line, gap table, and research scope', () => {
    const input: ScoreInput = {
      eligibility: { notIndexed: ['gemini'] },
      gaps: [{ query_id: 'best-mcp-trading', query_tier: 'head', sov: 0.1, top_competitor: 'altfins', top_competitor_domain: 'altfins.com' }],
    };
    const d = scoreWeek(input, OBJ);
    const md = renderDecisionBrief(d, input.gaps, 'Mon 22 Jun');

    expect(md).toContain('# GEO decision brief');
    expect(md).toContain('Mon 22 Jun');
    expect(md.toLowerCase()).toContain('eligibility');
    expect(md).toContain('candidate action: Prompt/fix-gemini-google-index-presence-w1.md');
    expect(md).toContain('best-mcp-trading'); // gap table row
    expect(md.toLowerCase()).toContain('research scope');
  });

  it('empty week renders a no-candidate brief without throwing', () => {
    const d = scoreWeek({ eligibility: { notIndexed: [] }, gaps: [] }, OBJ);
    const md = renderDecisionBrief(d, [], 'Mon 22 Jun');
    expect(md).toContain('# GEO decision brief');
    expect(md.toLowerCase()).toMatch(/no (candidate|move)/);
  });
});

describe('loadObjective — parses the real SoT', () => {
  it('parses landing/Prompt/geo-objective.yaml with the ratified weights + gate order', () => {
    const obj = loadObjective();
    expect(obj.priority_gate).toEqual(['eligibility', 'third_party', 'owned_content']);
    expect(obj.revenue_proximity.head).toBe(1.0);
    expect(obj.revenue_proximity.branded).toBe(0.8);
    expect(obj.revenue_proximity.niche).toBe(0.6);
    // branded must be weighted above niche (the architect's expected-value lift).
    expect(obj.revenue_proximity.branded).toBeGreaterThan(obj.revenue_proximity.niche);
  });

  it('GEO-TARGET-DIGEST-REDESIGN-W1 — misfits DROPPED (not down-weighted); product_fit map now empty', () => {
    const obj = loadObjective();
    // The two off-product misfits are REMOVED from geo-queries.yaml entirely (not merely down-weighted),
    // so product_fit no longer needs to carry them — the map is empty (every live query is on-fit).
    expect(obj.product_fit?.['best-python-backtester']).toBeUndefined();
    expect(obj.product_fit?.['python-quant-for-ai']).toBeUndefined();
    expect(Object.keys(obj.product_fit ?? {})).toHaveLength(0);
    // The OPEN-query seed mechanism is retained (unchanged).
    expect(obj.open_query?.move_type).toBe('seed_the_answer');
    expect(obj.open_query?.open_bonus).toBeGreaterThan(0);
    // INVARIANT still holds trivially while product_fit is empty: inject_threshold ≥ product_fit_threshold.
    expect(obj.inject_threshold ?? 0.5).toBeGreaterThanOrEqual(obj.open_query!.product_fit_threshold);
    expect(obj.score_formula).toContain('product_fit');
  });

  // GEO-TARGET-DIGEST-REDESIGN-W1 — the conversion-tiered target_set classification (the SoT).
  it('parses the target_set classification covering every live query (A / B / contested / measure_only)', () => {
    const obj = loadObjective();
    const ts = obj.target_set!;
    expect(ts).toBeDefined();
    const byTier: Record<string, number> = {};
    for (const v of Object.values(ts)) byTier[v.tier] = (byTier[v.tier] ?? 0) + 1;
    expect(byTier).toEqual({ A: 11, B: 6, contested: 2, measure_only: 1 });
    // the presence probe is measure_only; the 2 contested are earned-only.
    expect(ts['algovault-exists']).toMatchObject({ tier: 'measure_only', target_mode: 'measure_only' });
    expect(ts['best-mcp-trading']).toMatchObject({ tier: 'contested', target_mode: 'earned' });
    expect(ts['agent-signal-api']).toMatchObject({ tier: 'contested', target_mode: 'earned' });
    // every contested query is earned, and only contested queries are earned (the invariant).
    const earned = Object.keys(ts).filter((id) => ts[id].target_mode === 'earned').sort();
    const contested = Object.keys(ts).filter((id) => ts[id].tier === 'contested').sort();
    expect(earned).toEqual(contested);
    // the 6 NEW Tier-A buyer queries are classified A/owned.
    for (const id of ['trade-call-not-data', 'verifiable-winrate-api', 'altfins-alternative', 'x402-signal-api', 'signal-api-pricing', 'retail-signals-verifiable']) {
      expect(ts[id]).toMatchObject({ tier: 'A', target_mode: 'owned' });
    }
  });

  it('the target_set classifies exactly the live geo-queries.yaml id set (coverage canary)', () => {
    const obj = loadObjective();
    const queries = loadQueries();
    const queryIds = new Set(queries.map((q) => q.id));
    const tsIds = new Set(Object.keys(obj.target_set ?? {}));
    // no query missing a classification, no classification without a query.
    for (const id of queryIds) expect(tsIds.has(id)).toBe(true);
    for (const id of tsIds) expect(queryIds.has(id)).toBe(true);
  });
});

// GEO-TARGET-DIGEST-REDESIGN-W1 — the scorer's target_mode routing on the REAL objective.
describe('scoreWeek — contested → earned move (never a competitor placement / owned post)', () => {
  const gap = (query_id: string, hasLeader: boolean) => ({
    query_id,
    query_tier: 'branded',
    sov: 0.1,
    top_competitor: hasLeader ? 'altfins' : null,
    top_competitor_domain: hasLeader ? 'altfins.com' : null,
  });

  it('a contested query emits an `earned` move — NO domain, NO "pursue a placement", NOT owned', () => {
    const obj = loadObjective();
    const d = scoreWeek({ eligibility: { notIndexed: [] }, gaps: [gap('best-mcp-trading', true)] }, obj);
    const c = [...d.all.third_party, ...d.all.owned_content].find((x) => x.query_id === 'best-mcp-trading')!;
    expect(c.move).toBe('earned');
    expect(c.tier).toBe('third_party'); // earned is a third-party (draft-for-operator) channel, never owned_content
    expect(c.domain).toBeUndefined(); // no competitor domain attached
    expect(c.label).not.toMatch(/pursue a placement/i);
    expect(c.label).toMatch(/press \/ Reddit \/ third-party listicle/i);
    // and never an owned_content candidate for a contested query
    expect(d.all.owned_content.find((x) => x.query_id === 'best-mcp-trading')).toBeUndefined();
  });

  it('an owned Tier-A query with a leader still emits pursue_placement (unchanged)', () => {
    const obj = loadObjective();
    const d = scoreWeek({ eligibility: { notIndexed: [] }, gaps: [gap('composite-quant-signal', true)] }, obj);
    const c = d.all.third_party.find((x) => x.query_id === 'composite-quant-signal')!;
    expect(c.move).toBe('pursue_placement');
    expect(c.domain).toBe('altfins.com');
  });

  it('a measure_only (presence) query is SKIPPED — never a scored candidate', () => {
    const obj = loadObjective();
    const d = scoreWeek(
      { eligibility: { notIndexed: [] }, gaps: [{ query_id: 'algovault-exists', query_tier: 'presence', sov: 0.9, top_competitor: null, top_competitor_domain: null }] },
      obj,
    );
    const all = [...d.all.eligibility, ...d.all.third_party, ...d.all.owned_content];
    expect(all.find((x) => x.query_id === 'algovault-exists')).toBeUndefined();
  });

  it('a query ABSENT from target_set (a dropped misfit whose 4-week data lingers) is SKIPPED — never scored', () => {
    const obj = loadObjective();
    const d = scoreWeek(
      { eligibility: { notIndexed: [] }, gaps: [gap('best-python-backtester', true), gap('python-quant-for-ai', true), gap('composite-quant-signal', true)] },
      obj,
    );
    const all = [...d.all.eligibility, ...d.all.third_party, ...d.all.owned_content];
    // the two DROPPED misfits are gone from the decision (fixes the live dry-run leak)
    expect(all.find((x) => x.query_id === 'best-python-backtester')).toBeUndefined();
    expect(all.find((x) => x.query_id === 'python-quant-for-ai')).toBeUndefined();
    // the real target query is still scored
    expect(all.find((x) => x.query_id === 'composite-quant-signal')).toBeDefined();
  });
});
