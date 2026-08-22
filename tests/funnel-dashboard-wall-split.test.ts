/**
 * OPS-QUOTA-FUNNEL-WALL-SPLIT-W1 — the panel actually RENDERS the split.
 *
 * The dashboard shell is a JS string array, so `tsc` cannot see inside it and a reference error
 * there would surface only as a blank panel in production. These drive the real emitted script
 * through jsdom against a realistic payload — the live 30-day shape, where the pooled figure
 * clears the floor and every split cell does not.
 */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderFunnelDashboardHtml } from '../src/lib/funnel-dashboard-html.js';

const CELLS = [
  { bucket: 'daily', sessions: 14, rows: 1512, activated_to_wall: null, low_confidence: true, suppressed_reason: 'n=14 < 30 for this cell (pooled n is not a substitute)' },
  { bucket: 'monthly', sessions: 7, rows: 25543, activated_to_wall: null, low_confidence: true, suppressed_reason: 'n=7 < 30 for this cell (pooled n is not a substitute)' },
  { bucket: 'unknown', sessions: 21, rows: 51741, activated_to_wall: null, low_confidence: true, suppressed_reason: '`unknown` is the absence of a discriminator, not a wall — no rate is derivable' },
];

function payload(overrides: Record<string, unknown> = {}) {
  return {
    computed_at: '2026-08-22T10:33:08.000Z',
    window: { days: 30, from: '2026-07-23T10:33:08.000Z', to: '2026-08-22T10:33:08.000Z' },
    data_freshness: { snapshot_generated_at: null, stripe_source: 'unavailable' },
    paying_subscribers: {
      headline_source: 'unavailable', by_tier: { starter: null, pro: null, enterprise: null }, total: null,
      x402_separate: { payments_in_window: 0, distinct_wallets_in_window: 0, note: '' },
      enrichment: { profiles_total: 0, by_channel: {} },
      reconciliation: { divergent: false, note: '', stripe_total: null, profile_total: null, abs_gap: null, ratio: null },
    },
    free_signups: {
      reach_mcp_connect_all_time: 0,
      signup_intent: { total_all_time: 0, by_channel: {}, weekly: [] },
      free_accounts: 0,
      awareness_activation_collapse: { reach: 0, intent: 0, accounts: 0 },
    },
    conversion: { paid_over_free_accounts: null, paid_over_signup_intent: null, joinable_cohort: { attributed_conversions: 0, total_conversions: 0, note: '' }, unattributable_pct: null },
    human_funnel: {
      window: '30', stages: [{ key: 'a', label: 'A', sublabel: '', count: 1 }, { key: 'b', label: 'B', sublabel: '', count: 1 }],
      transitions: [{ from: 'A', to: 'B', rate: 1, drop: 0, verdict: 'g', benchmark: '', low_confidence: false }],
      biggest_leak: null, by_channel: [], engagement_proxy: { track_record_viewed: 0, landing_cta_clicked: 0, caveat: '' },
      ai_referral: null,
    },
    agent_funnel: {
      window: '30',
      stages: [{ key: 'a', label: 'A', sublabel: '', count: 1000 }, { key: 'b', label: 'B', sublabel: '', count: 800 }],
      transitions: [{ from: 'A', to: 'B', rate: 0.8, drop: 200, verdict: 'g', benchmark: '', low_confidence: false }],
      biggest_leak: null,
      quota_detail: { windowed_hard_block: 31, soft_approaching: 20, all_time_pqls: 10 },
      paid_detail: { distinct_wallets: 3, payments: 7, repeat_payers: [] },
      paid_note: 'Distinct paying WALLETS. Secondary count elsewhere.',
      quota_wall_split: {
        cells: CELLS,
        pooled_sessions: 31,
        pooled_low_confidence: false,
        multi_bucket_sessions: 6,
        mix: { daily_pct: null, monthly_pct: null, denominator: 21, excluded_unknown: 21, denominator_note: 'denominator = daily + monthly distinct sessions; `unknown` is excluded from BOTH numerator and denominator', low_confidence: true, suppressed_reason: 'n=21 < 30 across daily+monthly' },
        stages: [
          { event_type: 'quota_hit_soft', sessions: { daily: 12, monthly: 5, unknown: 22 }, rows: { daily: 130, monthly: 55, unknown: 1068 }, multi_bucket_sessions: 1, discriminator_cutover: { absent_until: '2026-08-14T05:01:54.732Z', live_since: '2026-08-15T21:39:50.063Z' }, window_predates_cutover: true },
          { event_type: 'quota_hit_hard', sessions: { daily: 10, monthly: 2, unknown: 22 }, rows: { daily: 114, monthly: 33, unknown: 3426 }, multi_bucket_sessions: 1, discriminator_cutover: { absent_until: '2026-08-14T06:02:02.952Z', live_since: '2026-08-15T22:39:54.582Z' }, window_predates_cutover: true },
          { event_type: 'quota_hit_block', sessions: { daily: 13, monthly: 7, unknown: 18 }, rows: { daily: 2678, monthly: 47095, unknown: 51741 }, multi_bucket_sessions: 6, discriminator_cutover: { absent_until: '2026-08-09T08:32:21.957Z', live_since: '2026-08-09T08:35:52.505Z' }, window_predates_cutover: false },
        ],
        claim: { claims: 1, with_inherited_usage: 1, inherited_usage_total: 115, inherited_usage_max: 115, first_claim_at: '2026-08-16T07:44:49.919Z' },
        pending: [
          { id: 'keyed_vs_keyless', question: 'Do callers who CLAIMED a free key hit the wall differently?', blocker: 'session_id never carries an av_free_ key', evidence: '0 of 34 distinct quota-stage sessions' },
          { id: 'wall_to_paid', question: 'Does a daily wall convert differently than a monthly one?', blocker: 'processed_x402_payments carries no session_id', evidence: 'structural' },
        ],
        unit_note: 'sessions = DISTINCT session_id. Buckets do NOT sum to the stage total.',
        cutover_note: 'Each stage carries its OWN bounds, derived from data.',
        guard_note: 'n<30 and cohort-maturity are applied PER CELL, not to the pooled stage.',
        warnings: [],
      },
      ...(overrides.agentExtra as object ?? {}),
    },
    hold_upside: { upside: [], avg_calls_per_active_agent: null, external_calls: 0, active_agents: 0, hold_calls: 0, hold_rate: null, trade_calls: 0, non_verdict_calls: 0, caveat: '' },
    retention: null,
    source_channels: null,
    client_activity_24h: null,
    daily: [],
    warnings: [],
    ...overrides,
  };
}

/** Boot the real emitted dashboard script against a payload and return the document. */
function renderWith(data: unknown): Document {
  const html = renderFunnelDashboardHtml();
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const w = dom.window as unknown as Record<string, unknown>;
  w.fetch = async () => ({ ok: true, json: async () => data });
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)![1];
  // `render` is a top-level declaration in the emitted script, so evaluating the script makes
  // it a global; calling it directly drives the real render path without the fetch bootstrap.
  dom.window.eval(script + '\n;render(' + JSON.stringify(data) + ');');
  return dom.window.document;
}

describe('funnel dashboard — the wall split renders', () => {
  it('🎯 renders three buckets, and `unknown` appears as its own row', () => {
    const doc = renderWith(payload());
    const text = doc.getElementById('wallsplit')!.textContent ?? '';
    expect(text).toContain('daily');
    expect(text).toContain('monthly');
    expect(text).toContain('unknown'); // never folded away
    expect(doc.querySelectorAll('#wallsplit tbody tr')).toHaveLength(3);
  });

  it('🎯 a suppressed cell shows its reason instead of a percentage', () => {
    const doc = renderWith(payload());
    const rows = [...doc.querySelectorAll('#wallsplit tbody tr')].map(r => r.textContent ?? '');
    const daily = rows.find(r => r.startsWith('daily'))!;
    expect(daily).toContain('n<30');
    expect(daily).toContain('n=14');
    expect(daily).not.toMatch(/\d+\.\d%/); // no rate rendered for a suppressed cell
  });

  it('🎯 states the mix denominator and the pooled-vs-cell contrast', () => {
    const doc = renderWith(payload());
    const mix = doc.getElementById('wallsplit-mix')!.textContent ?? '';
    expect(mix).toContain('excluded from BOTH');
    expect(mix).toContain('Pooled quota-crossing n=31');
    expect(mix).toContain('hit BOTH walls'); // the overlap is stated, not hidden
  });

  it('🎯 renders each stage with its OWN cutover bounds', () => {
    const doc = renderWith(payload());
    const t = doc.getElementById('wallsplit-stages')!.textContent ?? '';
    expect(t).toContain('2026-08-09T08:35:52.505Z'); // block
    expect(t).toContain('2026-08-15T21:39:50.063Z'); // soft
    expect(t).toContain('2026-08-15T22:39:54.582Z'); // hard — three instants, not one
  });

  it('🎯 renders the claim stage and both PENDING rows with their blockers', () => {
    const doc = renderWith(payload());
    expect(doc.getElementById('wallsplit-claim')!.textContent).toContain('1 claim(s)');
    expect(doc.getElementById('wallsplit-claim')!.textContent).toContain('115');
    const pending = doc.getElementById('wallsplit-pending')!.textContent ?? '';
    expect(pending).toContain('av_free_');
    expect(pending).toContain('no session_id');
    expect(doc.querySelectorAll('#wallsplit-pending tbody tr')).toHaveLength(2);
  });

  it('🎯 a null split says so rather than rendering a blank panel', () => {
    const p = payload();
    (p.agent_funnel as Record<string, unknown>).quota_wall_split = null;
    const doc = renderWith(p);
    expect(doc.getElementById('wallsplit-note')!.textContent).toContain('unavailable');
  });

  it('🎯 a producer-drift warning surfaces on the panel', () => {
    const p = payload();
    ((p.agent_funnel as Record<string, unknown>).quota_wall_split as Record<string, unknown>).warnings =
      ['quota_wall_split: SQL prefilter and classifyQuotaWall disagreed on 3 row(s)'];
    const doc = renderWith(p);
    expect(doc.getElementById('wallsplit-note')!.textContent).toContain('disagreed on 3 row(s)');
  });
});
