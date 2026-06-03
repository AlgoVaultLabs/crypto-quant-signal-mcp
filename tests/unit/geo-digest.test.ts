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
  buildDigest,
  type Verdict,
  type MomentumDeltas,
  type AttributionGap,
  type GeoDigestData,
} from '../../src/lib/geo-digest.js';

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
      { ...baseDeltas(), wowDropCount: 1, wowDropSummary: 'claude-web -25%' }, // slipping
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

  it('slipping when WoW drop fires — folds the WoW number into the verdict (R6)', () => {
    const m = computeMomentum({ ...baseDeltas(), wowDropCount: 1, wowDropSummary: 'claude-web -25%' });
    expect(m.verdict).toBe('slipping');
    expect(m.emoji).toBe('🔴');
    expect(m.headline).toContain('claude-web -25%');
  });

  it('slipping when leading indicators move down', () => {
    const m = computeMomentum({ ...baseDeltas(), citationsThisWeek: 1, citationsLastWeek: 4, sovThisWeek: 0, sovLastWeek: 0.05 });
    expect(m.verdict).toBe('slipping');
  });
});

describe('computeAttribution', () => {
  const gap = (over: Partial<AttributionGap>): AttributionGap => ({
    query_id: 'q',
    recommended_action: 'do x',
    injected_at: '2026-05-20T00:00:00Z',
    days_since_injected: 13,
    post_data_days: 13,
    cited_before: 0,
    cited_after: 0,
    mention_before: 0,
    mention_after: 0,
    ...over,
  });

  it('worked: citations rose after the move', () => {
    const [a] = computeAttribution([gap({ cited_before: 0, cited_after: 2 })]);
    expect(a.status).toBe('worked');
    expect(a.emoji).toBe('✅');
    expect(a.text).toContain('worked');
  });

  it('too_early: <7d of post-data', () => {
    const [a] = computeAttribution([gap({ post_data_days: 3 })]);
    expect(a.status).toBe('too_early');
    expect(a.emoji).toBe('⏳');
  });

  it('no_move: no change after the move', () => {
    const [a] = computeAttribution([gap({ cited_before: 1, cited_after: 1 })]);
    expect(a.status).toBe('no_move');
    expect(a.emoji).toBe('➖');
  });

  it('skips gaps <7d old', () => {
    expect(computeAttribution([gap({ days_since_injected: 3 })])).toHaveLength(0);
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
    attributionGaps: [
      {
        query_id: 'agent-signal-api',
        recommended_action: 'dev.to post',
        injected_at: '2026-06-01T00:00:00Z',
        days_since_injected: 8,
        post_data_days: 8,
        cited_before: 0,
        cited_after: 1,
        mention_before: 0,
        mention_after: 0,
      },
    ],
    contested: [
      { query_id: 'best-python-backtester', leader: 'vectorbt', domains: ['github.com', 'vectorbt.dev'], citations: 4 },
      { query_id: 'best-mcp-trading', leader: null, domains: [], citations: 0 },
    ],
    topGap: {
      query_id: 'best-mcp-trading',
      query_tier: 'head',
      recommended_action: 'ChatGPT cites mcp.so + an r/algotrading thread',
      top_competitor: 'mcp.so',
      top_competitor_domain: 'mcp.so',
    },
  };

  it('golden: assembles the target format with verdict header + 4 sections + link', () => {
    const out = buildDigest(data).join('\n');
    expect(out).toContain('📊 *GEO Weekly — Mon 9 Jun*');
    expect(out).toContain('🟢 *GAINING'); // citations up + new domain
    expect(out).toContain('*WHAT MOVED* (vs last week)');
    expect(out).toContain('3 answers linked algovault.com (↑ from 1)');
    expect(out).toContain('github awesome-quant ✅');
    expect(out).toContain('8% on claude-web');
    expect(out).toContain("DID LAST WEEK'S MOVE WORK?");
    expect(out).toContain('✅ agent-signal-api: citations 0→1 after the move → it worked');
    expect(out).toContain("WHO'S WINNING WHAT WE WANT");
    expect(out).toContain('best-python-backtester → vectorbt, cited via github.com + vectorbt.dev (4 citations)');
    expect(out).toContain('best-mcp-trading → no leader yet — OPEN');
    expect(out).toContain("THIS WEEK'S ONE MOVE");
    expect(out).toContain('best-mcp-trading (head): ChatGPT cites mcp.so');
    expect(out).toContain('Get AlgoVault a placement/answer on mcp.so');
    expect(out).toContain('Full numbers ↗ https://api.algovault.com/admin/geo-dashboard?key=<admin-key>');
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
    };
    const out = buildDigest(empty).join('\n');
    expect(out).toContain('🟡 *HOLDING');
    expect(out).toContain('no data yet');
    expect(out).toContain('No content moves are ≥7d old yet');
    expect(out).toContain('every query is OPEN');
    expect(out).toContain('No move queued');
  });
});
