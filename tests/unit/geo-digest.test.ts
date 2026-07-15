/**
 * GEO-MEASUREMENT-W4 — geo-digest unit tests.
 *
 *   - computeMomentum: gaining/holding/slipping + the single-source invariant
 *     (header emoji + headline word BOTH derive from `verdict`, can't contradict).
 *   - computeAttribution: worked / too-early / no-move + skips gaps <7d old.
 *   - buildDigest: golden-format check (target output) + graceful empty-state.
 *   - WoW fold: a >20%-drop fixture forces the `slipping` verdict (R6).
 */
import { describe, it, expect } from 'vitest';
import {
  computeMomentum,
  computeAttribution,
  computeIndexPresence,
  buildDigest,
  buildBySourceSection,
  buildOurActionSection,
  tierBadge,
  type Verdict,
  type MomentumDeltas,
  type AttributionGap,
  type GeoDigestData,
  type BySourceData,
  type OurActionRow,
} from '../../src/lib/geo-digest.js';
// GEO-TARGET-DIGEST-REDESIGN-W1 — fixtures use the SHARED rate helper so a test's before/after rate
// is byte-identical to what the cron feeds computeAttribution (single-derivation in the tests too).
import { computeAttributionRates, type QueryAttributionRate } from '../../src/lib/geo-rates.js';
import type { TargetSet } from '../../src/lib/geo-decide.js';

const VERDICT_EMOJI: Record<Verdict, string> = { gaining: '🟢', holding: '🟡', slipping: '🔴' };
const VERDICT_WORD: Record<Verdict, string> = { gaining: 'GAINING', holding: 'HOLDING', slipping: 'SLIPPING' };

const baseDeltas = (): MomentumDeltas => ({
  citationsThisWeek: 0,
  citationsLastWeek: 0,
  newTrustedDomains: [],
  sovThisWeek: 0,
  sovLastWeek: 0,
  mentionRateThisWeek: 0,
  mentionRateLastWeek: 0,
  wowDropCount: 0,
  wowDropSummary: '',
});

describe('computeMomentum', () => {
  it('single-source invariant: emoji + headline word both derive from verdict', () => {
    const fixtures: MomentumDeltas[] = [
      { ...baseDeltas(), citationsThisWeek: 3, citationsLastWeek: 1, newTrustedDomains: ['github'] }, // gaining
      baseDeltas(), // holding
      { ...baseDeltas(), citationsThisWeek: 6, citationsLastWeek: 8, weeklyCitations: [6, 8, 10] }, // slipping (sustained)
    ];
    for (const d of fixtures) {
      const m = computeMomentum(d);
      expect(m.emoji).toBe(VERDICT_EMOJI[m.verdict]);
      expect(m.headline.startsWith(VERDICT_WORD[m.verdict])).toBe(true);
    }
  });

  it('gaining when leading indicators move up', () => {
    const m = computeMomentum({ ...baseDeltas(), citationsThisWeek: 3, citationsLastWeek: 1, newTrustedDomains: ['github'] });
    expect(m.verdict).toBe('gaining');
    expect(m.emoji).toBe('🟢');
    expect(m.drivers.length).toBeGreaterThan(0);
  });

  it('holding for a flat pre-visibility week', () => {
    const m = computeMomentum(baseDeltas());
    expect(m.verdict).toBe('holding');
    expect(m.headline).toContain('pre-visibility');
  });

  // OPS-GEO-PROBE-SIGNIFICANCE-GATE-W1 — SLIPPING is now significance-gated.
  it('slipping ONLY on a sustained, significant citation decline (≥2 consecutive ≥20%, n≥5)', () => {
    const m = computeMomentum({
      ...baseDeltas(),
      citationsThisWeek: 6,
      citationsLastWeek: 8,
      weeklyCitations: [6, 8, 10],
      wowDropCount: 2,
      wowDropSummary: 'chatgpt -64%, claude-web -25%',
    });
    expect(m.verdict).toBe('slipping');
    expect(m.emoji).toBe('🔴');
    expect(m.headline).toContain('sustained');
    expect(m.headline).toContain('chatgpt -64%'); // raw per-engine numbers still surfaced
  });

  // Regression: the exact Mon-29 false alarm — a 2→0 citation move on n=2 with a per-engine
  // mention wobble. Pre-fix this fired 🔴 SLIPPING; the gate now holds it as low-sample noise.
  it('a low-sample 2→0 citation drop is HOLDING (low sample), never SLIPPING', () => {
    const m = computeMomentum({
      ...baseDeltas(),
      citationsThisWeek: 0,
      citationsLastWeek: 2,
      weeklyCitations: [0, 2],
      wowDropCount: 1,
      wowDropSummary: 'chatgpt -64%',
    });
    expect(m.verdict).toBe('holding');
    expect(m.emoji).toBe('🟡');
    expect(m.headline).toContain('low sample');
  });

  it('a single 30% down-week with n≥5 is HOLDING (1 down-week, watching), not yet SLIPPING', () => {
    const m = computeMomentum({
      ...baseDeltas(),
      citationsThisWeek: 7,
      citationsLastWeek: 10,
      weeklyCitations: [7, 10, 10],
    });
    expect(m.verdict).toBe('holding');
    expect(m.headline).toContain('1 down-week');
  });
});

// GEO-TARGET-DIGEST-REDESIGN-W1 (a) — full-funnel attribution: mention + cited + SoV RATE Δ, "works
// if it lifts the LEADING indicator (mention) even while cited is flat". Rate built via the SHARED
// computeAttributionRates (same wilsonInterval math as production).
const rateOf = (
  query_id: string,
  rb: number, cb: number, mb: number, sb: number,
  ra: number, ca: number, ma: number, sa: number,
): QueryAttributionRate =>
  computeAttributionRates([
    { query_id, runs_before: rb, cited_before: cb, mention_before: mb, sov_before: sb, runs_after: ra, cited_after: ca, mention_after: ma, sov_after: sa },
  ])[0];

describe('computeAttribution (full-funnel: mention + cited + SoV Δ)', () => {
  const gap = (over: Partial<AttributionGap>): AttributionGap => ({
    query_id: 'q',
    tier: 'A',
    recommended_action: 'do x',
    injected_at: '2026-05-20T00:00:00Z',
    days_since_injected: 13,
    post_data_days: 13,
    rate: rateOf('q', 9, 0, 0, 0, 9, 0, 0, 0), // flat by default
    ...over,
  });

  it('WORKED on the LEADING indicator: mention rose even while cited is FLAT (the false-negative fix)', () => {
    const [a] = computeAttribution([gap({ rate: rateOf('q', 9, 1, 0, 0.02, 9, 1, 1, 0.05) })]);
    expect(a.status).toBe('worked');
    expect(a.emoji).toBe('✅');
    expect(a.text).toContain('leading indicator (mention) up');
    expect(a.text).toContain('mention 0→11%'); // a RATE, not a raw count
    expect(a.text).toContain('cited 11→11%'); // cited FLAT — still counts as worked
    expect(a.text).toContain('SoV 0.02→0.05');
  });

  it('worked on cited when only the cited rate rose', () => {
    const [a] = computeAttribution([gap({ rate: rateOf('q', 10, 0, 0, 0, 10, 3, 0, 0) })]);
    expect(a.status).toBe('worked');
    expect(a.text).toContain('cited up');
  });

  it('too_early: <7d of post-data', () => {
    const [a] = computeAttribution([gap({ post_data_days: 3 })]);
    expect(a.status).toBe('too_early');
    expect(a.emoji).toBe('⏳');
  });

  it('no_move: neither the mention nor the cited rate lifted', () => {
    const [a] = computeAttribution([gap({ rate: rateOf('q', 10, 1, 1, 0.05, 10, 1, 1, 0.05) })]);
    expect(a.status).toBe('no_move');
    expect(a.emoji).toBe('➖');
    expect(a.text).toContain('no lift');
  });

  it('skips gaps <7d old', () => {
    expect(computeAttribution([gap({ days_since_injected: 3 })])).toHaveLength(0);
  });

  it('(e) badges the row by conversion tier', () => {
    const [a] = computeAttribution([gap({ tier: 'A', rate: rateOf('q', 9, 1, 0, 0, 9, 1, 1, 0.05) })]);
    expect(a.text).toContain('🎯 conversion');
  });
});

describe('buildDigest', () => {
  const data: GeoDigestData = {
    dateLabel: 'Mon 9 Jun',
    dashboardUrl: 'https://api.algovault.com/admin/geo-dashboard',
    momentumDeltas: {
      citationsThisWeek: 3,
      citationsLastWeek: 1,
      newTrustedDomains: ['github awesome-quant'],
      sovThisWeek: 0.08,
      sovLastWeek: 0.08,
      mentionRateThisWeek: 8,
      mentionRateLastWeek: 8,
      wowDropCount: 0,
      wowDropSummary: '',
    },
    perEngineMention: [{ model: 'claude-haiku-4-5-20251001', mention_rate_pct: 8, cited_rate_pct: 20 }],
    // (a) full-funnel: mention rose 0→22% while cited flat → worked on the LEADING indicator.
    attributionGaps: [
      {
        query_id: 'agent-signal-api',
        tier: 'contested',
        recommended_action: 'earned draft',
        injected_at: '2026-06-01T00:00:00Z',
        days_since_injected: 8,
        post_data_days: 8,
        rate: rateOf('agent-signal-api', 9, 0, 0, 0.01, 9, 0, 2, 0.04),
      },
    ],
    // (b) target-only who's-winning (misfits already filtered by the cron; badged by tier (e)).
    contested: [
      { query_id: 'agent-signal-api', leader: 'altfins', domains: ['altfins.com', 'g2.com'], citations: 4 },
      { query_id: 'best-mcp-trading', leader: null, domains: [], citations: 0 },
    ],
    topGap: {
      query_id: 'best-mcp-trading',
      query_tier: 'head',
      recommended_action: 'ChatGPT cites mcp.so + an r/algotrading thread',
      top_competitor: 'mcp.so',
      top_competitor_domain: 'mcp.so',
    },
    indexPresence: computeIndexPresence([
      { model: 'gpt-4.1-mini', present: true },
      { model: 'claude-haiku-4-5-20251001', present: true },
      { model: 'gemini-2.5-flash', present: true },
      { model: 'sonar', present: true },
    ]),
    targetSet: {
      'composite-quant-signal': { tier: 'A', audience: 'T2/T3', target_mode: 'owned' },
      'ai-agent-trade-signals': { tier: 'B', audience: 'ALL', target_mode: 'owned' },
      'agent-signal-api': { tier: 'contested', audience: 'T2/T3', target_mode: 'earned' },
      'best-mcp-trading': { tier: 'contested', audience: 'T3', target_mode: 'earned' },
    } as TargetSet,
    // (c) per-query our-action: posted / in-flight / none.
    ourAction: [
      { query_id: 'composite-quant-signal', tier: 'A', status: 'posted', posted_date: '2026-06-01', mention_rate_pct: 11, cited_rate_pct: 10, low_confidence: false },
      { query_id: 'ai-agent-trade-signals', tier: 'B', status: 'in_flight', posted_date: null, mention_rate_pct: 5, cited_rate_pct: 0, low_confidence: false },
      { query_id: 'agent-signal-api', tier: 'contested', status: 'none', posted_date: null, mention_rate_pct: 0, cited_rate_pct: 0, low_confidence: true },
    ],
  };

  it('golden: verdict header + full-funnel attribution + target-only who\'s-winning + our-action + split', () => {
    const out = buildDigest(data).join('\n');
    expect(out).toContain('📊 *GEO Weekly — Mon 9 Jun*');
    expect(out).toContain('🟢 *GAINING'); // citations up + new domain
    expect(out).toContain('*WHAT MOVED* (vs last week)');
    expect(out).toContain('3 answers linked algovault.com (↑ from 1)');
    expect(out).toContain('github awesome-quant ✅');
    expect(out).toContain('8% on claude-web');
    expect(out).toContain("DID LAST WEEK'S MOVE WORK?");
    // (a) full-funnel attribution — mention RATE Δ, worked on the leading indicator, badged
    expect(out).toContain('agent-signal-api [🤝 earned]');
    expect(out).toContain('leading indicator (mention) up');
    expect(out).toContain('mention 0→22%');
    // (c) our-action section — posted+date + in-flight + badges
    expect(out).toContain('OUR ACTION PER TARGET QUERY');
    expect(out).toContain('✅ composite-quant-signal [🎯 conversion]: posted 2026-06-01');
    expect(out).toContain('🔵 ai-agent-trade-signals [📣 brand-presence]: decision in-flight');
    // (b) target-only who's-winning + (e) badges
    expect(out).toContain("*🥊 WHO'S WINNING WHAT WE WANT* (target queries only)");
    expect(out).toContain('agent-signal-api [🤝 earned] → altfins, cited via altfins.com + g2.com (4 citations)');
    expect(out).toContain('best-mcp-trading [🤝 earned] → no leader yet — OPEN');
    // (e) the Tier-B ≠ pipeline guardrail
    expect(out).toContain('do NOT count as pipeline');
    expect(out).toContain("THIS WEEK'S ONE MOVE");
    expect(out).toContain('best-mcp-trading (head): ChatGPT cites mcp.so');
    expect(out).toContain('Full numbers ↗ https://api.algovault.com/admin/geo-dashboard?key=<admin-key>');
    // R5 — index-presence line present; all ✓ → no blocked banner
    expect(out).toContain('Cited by engine: chatgpt ✓ (Bing) · claude ✓ (Brave) · gemini ✓ (Google) · perplexity ✓');
    expect(out).not.toContain('BLOCKED ELIGIBILITY');
  });

  it('header verdict matches body (no contradiction) — emoji == verdict', () => {
    const lines = buildDigest(data);
    const header = lines.find((l) => l.includes('GAINING') || l.includes('HOLDING') || l.includes('SLIPPING'))!;
    const m = computeMomentum(data.momentumDeltas);
    expect(header).toContain(m.emoji);
    expect(header).toContain(VERDICT_WORD[m.verdict]);
  });

  it('empty-state degrades gracefully (pre-first-probe)', () => {
    const empty: GeoDigestData = {
      dateLabel: 'Mon 9 Jun',
      dashboardUrl: 'https://api.algovault.com/admin/geo-dashboard',
      momentumDeltas: baseDeltas(),
      perEngineMention: [],
      attributionGaps: [],
      contested: [],
      topGap: null,
      indexPresence: computeIndexPresence([]),
    };
    const out = buildDigest(empty).join('\n');
    expect(out).toContain('🟡 *HOLDING');
    expect(out).toContain('no data yet');
    expect(out).toContain('No content moves are ≥7d old yet');
    expect(out).toContain('every target is OPEN');
    expect(out).toContain('No move queued');
    // R5 — index presence graceful pre-first-probe, no banner
    expect(out).toContain('Cited by engine: no data yet — first probe Mon');
    expect(out).not.toContain('BLOCKED ELIGIBILITY');
  });

  it('R5 (fast-follow): an AUTHORITATIVE notIndexed substrate fires the 🔴 BLOCKED ELIGIBILITY banner', () => {
    const blocked: GeoDigestData = { ...data, eligibilityNotIndexed: ['gemini'] };
    const out = buildDigest(blocked).join('\n');
    expect(out).toContain('🔴 *BLOCKED ELIGIBILITY* — not indexed on gemini.');
    expect(out).toContain('🟢 *GAINING'); // distinct from the authority verdict
  });

  it('R5 (fast-follow): a presence MISS while INDEXED is a soft citation gap, NOT the red banner', () => {
    // INDEXED != CITED — claude not retrieved this week but IS indexed (absent from
    // eligibilityNotIndexed) → no re-crawl alarm, just the soft authority-gap note.
    const citationGap: GeoDigestData = {
      ...data,
      indexPresence: computeIndexPresence([
        { model: 'gpt-4.1-mini', present: true },
        { model: 'claude-haiku-4-5-20251001', present: false },
        { model: 'gemini-2.5-flash', present: true },
        { model: 'sonar', present: true },
      ]),
      citationGapEngines: ['claude'],
    };
    const out = buildDigest(citationGap).join('\n');
    expect(out).not.toContain('BLOCKED ELIGIBILITY'); // the core correction
    expect(out).toContain('claude: indexed ✓ but not yet citing us');
    expect(out).toContain('chatgpt ✓ (Bing) · claude ✗ (Brave)'); // retrieval line still shows ✗
  });

  // GEO-AUTOPILOT-W1 (C3) — the scored decision handoff replaces the naive ONE MOVE.
  it('renders the DECISION READY handoff when a decision is present (replaces ONE MOVE)', () => {
    const withDecision: GeoDigestData = {
      ...data,
      decision: {
        priorityTier: 'eligibility',
        gateLabel: 'ELIGIBILITY (gate 1/3)',
        move: "gemini can't retrieve algovault.com — fix the re-crawl before any authority work",
        knownActionSpec: 'Prompt/fix-gemini-google-index-presence-w1.md',
        candidateCount: 1,
        briefName: 'geo-decision-2026-06-22',
        suspects: ['algovault.io', 'algovaults.com'],
      },
    };
    const out = buildDigest(withDecision).join('\n');
    expect(out).toContain('🎯 *DECISION READY*');
    expect(out).toContain('Priority: ELIGIBILITY (gate 1/3)');
    expect(out).toContain('candidate action: Prompt/fix-gemini-google-index-presence-w1.md');
    expect(out).toContain('geo-decision-2026-06-22');
    expect(out).toContain('In Cowork:');
    expect(out).toContain('algovault.io'); // look-alike watch line
    expect(out).not.toContain("THIS WEEK'S ONE MOVE"); // replaced, not duplicated
  });

  it('falls back to the W4 ONE MOVE when no decision is set (additive / backward-compatible)', () => {
    const out = buildDigest(data).join('\n'); // `data` carries no `decision`
    expect(out).toContain("THIS WEEK'S ONE MOVE");
    expect(out).not.toContain('DECISION READY');
  });

  // GEO-TARGET-DIGEST-REDESIGN-W1 (d) — decision-basis: the ranked candidates + scores are auditable.
  it('(d) renders the decision BASIS — top-N ranked candidates + scores/tier/product-fit', () => {
    const withBasis: GeoDigestData = {
      ...data,
      decision: {
        priorityTier: 'third_party',
        gateLabel: 'THIRD-PARTY (gate 2/3)',
        move: 'earned',
        candidateCount: 2,
        briefName: 'geo-decision-2026-06-22',
        suspects: [],
        rankedCandidates: [
          { query_id: 'best-mcp-trading', query_tier: 'head', target_tier: 'contested', move: 'earned', expected_lift: 0.9, product_fit: 1, score: 0.6 },
          { query_id: 'composite-quant-signal', query_tier: 'branded', target_tier: 'A', move: 'seed_the_answer', expected_lift: 0.85, product_fit: 1, score: 0.51 },
        ],
      },
    };
    const out = buildDigest(withBasis).join('\n');
    expect(out).toContain('Basis — ranked candidates');
    expect(out).toContain('1. best-mcp-trading [🤝 earned] · earned · score 0.60 (lift 0.90 · fit 1.00 · head)');
    expect(out).toContain('2. composite-quant-signal [🎯 conversion] · seed_the_answer · score 0.51');
  });

  // (b) target-only who's-winning — a dropped-misfit query never renders even if passed in.
  it('(b) filters a dropped misfit out of who\'s-winning when it is absent from target_set', () => {
    const withMisfit: GeoDigestData = {
      ...data,
      contested: [
        { query_id: 'best-python-backtester', leader: 'vectorbt', domains: ['vectorbt.dev'], citations: 9 }, // dropped misfit
        { query_id: 'agent-signal-api', leader: 'altfins', domains: ['altfins.com'], citations: 4 }, // target
      ],
    };
    const out = buildDigest(withMisfit).join('\n');
    expect(out).not.toContain('best-python-backtester'); // misfit excluded
    expect(out).not.toContain('vectorbt'); // no more vectorbt every week
    expect(out).toContain('agent-signal-api [🤝 earned] → altfins');
  });
});

// GEO-TARGET-DIGEST-REDESIGN-W1 (c)(e) — the per-query "our action" section + tier badges.
describe('buildOurActionSection + tierBadge (our-action + conversion split)', () => {
  it('tierBadge maps the conversion tiers (Tier-B never masquerades as pipeline)', () => {
    expect(tierBadge('A')).toBe('🎯 conversion');
    expect(tierBadge('B')).toBe('📣 brand-presence');
    expect(tierBadge('contested')).toBe('🤝 earned');
    expect(tierBadge('measure_only')).toBe('');
    expect(tierBadge(undefined)).toBe('');
  });

  it('undefined/empty → no section (back-compat)', () => {
    expect(buildOurActionSection(undefined)).toEqual([]);
    expect(buildOurActionSection([])).toEqual([]);
  });

  it('renders posted / in-flight / none grouped Tier-A → B → contested, each badged + trend', () => {
    const rows: OurActionRow[] = [
      { query_id: 'best-mcp-trading', tier: 'contested', status: 'none', posted_date: null, mention_rate_pct: 0, cited_rate_pct: 0, low_confidence: true },
      { query_id: 'ai-agent-trade-signals', tier: 'B', status: 'in_flight', posted_date: null, mention_rate_pct: 5, cited_rate_pct: 0, low_confidence: false },
      { query_id: 'composite-quant-signal', tier: 'A', status: 'posted', posted_date: '2026-07-01', mention_rate_pct: 11, cited_rate_pct: 10, low_confidence: false },
    ];
    const out = buildOurActionSection(rows);
    const joined = out.join('\n');
    expect(joined).toContain('OUR ACTION PER TARGET QUERY');
    expect(joined).toContain('✅ composite-quant-signal [🎯 conversion]: posted 2026-07-01 — mention 11% · cited 10%');
    expect(joined).toContain('🔵 ai-agent-trade-signals [📣 brand-presence]: decision in-flight');
    expect(joined).toContain('⚪ best-mcp-trading [🤝 earned]: no action yet');
    // grouped Tier-A first, then B, then contested (deterministic order)
    expect(joined.indexOf('composite-quant-signal')).toBeLessThan(joined.indexOf('ai-agent-trade-signals'));
    expect(joined.indexOf('ai-agent-trade-signals')).toBeLessThan(joined.indexOf('best-mcp-trading'));
  });
});

describe('computeIndexPresence (R5)', () => {
  it('all engines indexed → not blocked, ordered chatgpt→claude→gemini→perplexity', () => {
    const ip = computeIndexPresence([
      { model: 'sonar', present: true },
      { model: 'gemini-2.5-flash', present: true },
      { model: 'gpt-4.1-mini', present: true },
      { model: 'claude-haiku-4-5-20251001', present: true },
    ]);
    expect(ip.blocked).toBe(false);
    expect(ip.missing).toEqual([]);
    expect(ip.hasData).toBe(true);
    expect(ip.line).toBe('chatgpt ✓ (Bing) · claude ✓ (Brave) · gemini ✓ (Google) · perplexity ✓');
  });

  it('a missing substrate → blocked, named in missing[], ✗ in the line', () => {
    const ip = computeIndexPresence([
      { model: 'gpt-4.1-mini', present: true },
      { model: 'claude-haiku-4-5-20251001', present: false },
      { model: 'gemini-2.5-flash', present: true },
      { model: 'sonar', present: false },
    ]);
    expect(ip.blocked).toBe(true);
    expect(ip.missing).toEqual(['claude', 'perplexity']);
    expect(ip.line).toContain('claude ✗ (Brave)');
    expect(ip.line).toContain('perplexity ✗');
  });

  it('empty input → graceful pre-first-probe state', () => {
    const ip = computeIndexPresence([]);
    expect(ip.hasData).toBe(false);
    expect(ip.blocked).toBe(false);
    expect(ip.line).toBe('no data yet — first probe Mon');
  });
});

// OPS-WEEKLY-GROWTH-DIGEST-W1 — the folded ACQUISITION (by_source) section.
describe('buildBySourceSection (acquisition fold)', () => {
  const populated: BySourceData = {
    rows: [
      { source: 'chatgpt', connects: 12, connectsLastWeek: 8, firstCall: 9, conversion: 1 },
      { source: 'docs', connects: 5, connectsLastWeek: 7, firstCall: 3, conversion: 2 },
      { source: 'unknown', connects: 4, connectsLastWeek: 0, firstCall: 1, conversion: 0 },
    ],
    totalConnectsThisWeek: 21,
    totalConnectsLastWeek: 15,
    // A4: best CONVERTER is `docs` (2 paid) even though `chatgpt` has the most CONNECTS — value, not volume.
    topConverter: { source: 'docs', conversion: 2, connects: 5 },
    topMover: { source: 'chatgpt', from: 8, to: 12 },
  };

  it('undefined / null → no section (back-compat for pre-W1 callers)', () => {
    expect(buildBySourceSection(undefined)).toEqual([]);
    expect(buildBySourceSection(null)).toEqual([]);
  });

  it('empty (0 connects this week) → "attribution collecting" line', () => {
    const out = buildBySourceSection({
      rows: [],
      totalConnectsThisWeek: 0,
      totalConnectsLastWeek: 0,
      topMover: null,
      topConverter: null,
    }).join('\n');
    expect(out).toContain('*📈 ACQUISITION*');
    expect(out).toContain('attribution collecting — 0 connects captured this week so far');
  });

  it('populated: per-source connects with WoW arrows + first-call + paid', () => {
    const out = buildBySourceSection(populated).join('\n');
    expect(out).toContain('chatgpt: 12 connects (↑ from 8) · 9 first-call · 1 paid');
    expect(out).toContain('docs: 5 connects (↓ from 7) · 3 first-call · 2 paid');
    expect(out).toContain('unknown: 4 connects (new) · 1 first-call · 0 paid');
  });

  it('A4: highlights the best CONVERTER (value), not the highest connect-volume source', () => {
    const out = buildBySourceSection(populated).join('\n');
    // docs converts (2 paid from 5 → 40%), chatgpt has more connects but fewer paid.
    expect(out).toContain('💰 Best converter: docs — 2 paid from 5 connects (40%)');
    expect(out).not.toContain('Best converter: chatgpt');
  });

  it('flags the biggest WoW connect mover', () => {
    const out = buildBySourceSection(populated).join('\n');
    expect(out).toContain('🚀 Biggest mover: chatgpt +4 (8→12) connects');
  });

  it('no conversions this week → explicit "no conversions" line', () => {
    const out = buildBySourceSection({
      rows: [{ source: 'chatgpt', connects: 3, connectsLastWeek: 0, firstCall: 1, conversion: 0 }],
      totalConnectsThisWeek: 3,
      totalConnectsLastWeek: 0,
      topMover: { source: 'chatgpt', from: 0, to: 3 },
      topConverter: null,
    }).join('\n');
    expect(out).toContain('💰 Best converter: no conversions captured yet this week');
    expect(out).toContain('🚀 Biggest mover: chatgpt new this week connects');
  });

  it('buildDigest folds the section in when bySource is set, and stays byte-stable when omitted', () => {
    const base: GeoDigestData = {
      dateLabel: 'Mon 9 Jun',
      dashboardUrl: 'https://api.algovault.com/admin/geo-dashboard',
      momentumDeltas: baseDeltas(),
      perEngineMention: [],
      attributionGaps: [],
      contested: [],
      topGap: null,
      indexPresence: computeIndexPresence([]),
    };
    const without = buildDigest(base).join('\n');
    expect(without).not.toContain('ACQUISITION');

    const withSrc = buildDigest({ ...base, bySource: populated }).join('\n');
    expect(withSrc).toContain('*📈 ACQUISITION* (by source · vs last week)');
    expect(withSrc).toContain('chatgpt: 12 connects (↑ from 8)');
    // folded BETWEEN "WHAT MOVED" and "DID LAST WEEK'S MOVE WORK"
    expect(withSrc.indexOf('WHAT MOVED')).toBeLessThan(withSrc.indexOf('ACQUISITION'));
    expect(withSrc.indexOf('ACQUISITION')).toBeLessThan(withSrc.indexOf("DID LAST WEEK'S MOVE WORK"));
    // GEO sections still intact (fold is additive)
    expect(withSrc).toContain("THIS WEEK'S ONE MOVE");
  });
});
