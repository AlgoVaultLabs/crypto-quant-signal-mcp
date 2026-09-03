/**
 * tests/unit/venue-readiness-report.test.ts — OPS-SHADOW-PIPELINE-W1 / C5.
 * Pure buildReport/venueVerdict: all-17 coverage, READY-TO-LAUNCH block,
 * per-state glyphs, PFE-WR-only (no outcome_return_pct/Phase-E leakage).
 */
import { describe, it, expect } from 'vitest';
import { buildReport, venueVerdict, isDigestActionable } from '../../src/scripts/venue-readiness-report.js';
import type { VenueRecord } from '../../src/types.js';

function v(id: string, status: VenueRecord['status'], min = 500, overrides: Partial<VenueRecord> = {}): VenueRecord {
  return {
    exchange_id: id, status, asset_count: 100, min_buy_sell_sample: min,
    integrated_at: '2026-05-16T00:00:00Z', promoted_at: null, retired_at: null,
    extension_count: 0, last_eval_at: null, last_eval_pfe_wr: null,
    last_eval_buy_sell_count: null, seeding_started_at: null, notes: null, ...overrides,
  };
}

describe('venue-readiness-report buildReport (C5)', () => {
  it('renders a keyword line for ALL 17 venues, READY(0) when none qualify, no forbidden fields', () => {
    const promoted = ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET'].map(id => v(id, 'promoted'));
    const shadow = ['ASTER', 'EDGEX', 'GATE', 'MEXC', 'KUCOIN', 'PHEMEX', 'BINGX', 'HTX', 'WEEX', 'BITMART', 'XT', 'WHITEBIT'].map(id => v(id, 'shadow'));
    const rows = [...promoted, ...shadow];
    const stats = new Map(rows.map(r => [r.exchange_id, { pfe_wr: null, buy_sell_count: 0, days_since: 0 }]));
    const text = buildReport(rows, stats, '2026-06-01').join('\n\n');

    const matches = text.split('\n').filter(l => /QUALIFIED|sample|no pipeline|within initial|already live/.test(l));
    expect(matches.length).toBeGreaterThanOrEqual(17);
    expect(text).toContain('READY TO LAUNCH (0)');
    expect(text).not.toMatch(/outcome_return_pct|outcome_price|phase_e_wr|phaseE/);
  });

  it('populates READY-TO-LAUNCH for a qualifying shadow venue + the exact promote command', () => {
    const rows = [v('HL', 'promoted'), v('XT', 'shadow', 500)];
    const stats = new Map([
      ['HL', { pfe_wr: 0.9, buy_sell_count: 9999, days_since: 60 }],
      ['XT', { pfe_wr: 0.84, buy_sell_count: 520, days_since: 18 }], // qualified
    ]);
    const text = buildReport(rows, stats, '2026-06-05').join('\n\n');
    expect(text).toMatch(/READY TO LAUNCH \(1\)/);
    expect(text).toContain('npx tsx src/scripts/promote-venue.ts XT');
    expect(text).toMatch(/✅ XT — QUALIFIED/);
  });
});

describe('venueVerdict — WR on in-window + seeding lines (OPS-SHADOW-WINDOW-RESET-AND-WR-DISPLAY-W1)', () => {
  it('in-window venue with a non-null pfe_wr renders WR <pct>', () => {
    const line = venueVerdict(v('C', 'shadow'), { pfe_wr: 0.75, buy_sell_count: 50, days_since: 3 }).line;
    expect(line).toContain('within initial window (day 3/15)');
    expect(line).toContain('WR 75.0%');
  });

  it('in-window venue with null pfe_wr renders WR n/a', () => {
    const line = venueVerdict(v('C2', 'shadow'), { pfe_wr: null, buy_sell_count: 50, days_since: 3 }).line;
    expect(line).toContain('within initial window');
    expect(line).toContain('WR n/a (no Phase-E outcomes yet)');
  });

  it('seeding line shows WR n/a (HOLDs only — no BUY/SELL yet)', () => {
    const line = venueVerdict(
      v('B2', 'shadow', 500, { seeding_started_at: '2026-06-01T08:45:00Z' }),
      { pfe_wr: null, buy_sell_count: 0, days_since: 0 },
    ).line;
    expect(line).toContain('seeding, sample 0/500');
    expect(line).toContain('WR n/a');
  });
});

describe('venueVerdict — per-state glyphs (C5)', () => {
  it('classifies every readiness state', () => {
    expect(venueVerdict(v('A', 'promoted'), { pfe_wr: null, buy_sell_count: 0, days_since: 0 }).line).toContain('already live');
    expect(venueVerdict(v('B', 'shadow'), { pfe_wr: null, buy_sell_count: 0, days_since: 0 }).line).toContain('no pipeline yet');
    // seeding_started_at set + 0 BUY/SELL → actively seeding, HOLDs only (NOT "no pipeline")
    expect(venueVerdict(v('B2', 'shadow', 500, { seeding_started_at: '2026-06-01T08:45:00Z' }), { pfe_wr: null, buy_sell_count: 0, days_since: 0 }).line).toContain('seeding, sample 0/500');
    expect(venueVerdict(v('C', 'shadow'), { pfe_wr: null, buy_sell_count: 50, days_since: 3 }).line).toContain('within initial window');
    expect(venueVerdict(v('D', 'shadow'), { pfe_wr: null, buy_sell_count: 50, days_since: 20 }).line).toContain('WR n/a');
    expect(venueVerdict(v('E', 'shadow'), { pfe_wr: 0.9, buy_sell_count: 400, days_since: 20 }).line).toContain('need 100 more');
    expect(venueVerdict(v('F', 'shadow'), { pfe_wr: 0.65, buy_sell_count: 600, days_since: 20 }).line).toContain('< 80%');
    const q = venueVerdict(v('G', 'shadow'), { pfe_wr: 0.85, buy_sell_count: 600, days_since: 20 });
    expect(q.qualified).toBe(true);
    expect(q.line).toContain('QUALIFIED');
  });
});

/**
 * OPS-BITMART-ENUM-RECONCILE-W1 CH5 — the actionability predicate, BOTH DIRECTIONS.
 *
 * A suppression-only test would let the SEND path rot dark — the "installed is not working" class.
 * So every actionable condition gets its own must-SEND case, and silence gets its own.
 */
describe('CH5 — the digest speaks only when there is something to act on', () => {
  const promotedFine = (id: string) => v(id, 'promoted', 100);
  const okStats = { pfe_wr: 0.95, buy_sell_count: 500, days_since: 90 };

  it('SILENT when nothing is actionable — no shadow, none qualified, none below bar', () => {
    const rows = ['HL', 'BINANCE'].map(promotedFine);
    // already-promoted venues short-circuit to "already live", so they are not qualified/below-bar
    const stats = new Map(rows.map(r => [r.exchange_id, okStats]));
    const res = isDigestActionable(rows, stats);
    expect(res.actionable).toBe(false);
    expect(res.reason).toMatch(/0 shadow/);
  });

  it('SENDS when ≥1 shadow venue exists (an onboarding is in flight)', () => {
    const rows = [promotedFine('HL'), v('WEEX', 'shadow', 100)];
    const stats = new Map(rows.map(r => [r.exchange_id, okStats]));
    expect(isDigestActionable(rows, stats).actionable).toBe(true);
  });

  it('SENDS when a shadow venue is ✅ QUALIFIED (waiting on a promote decision)', () => {
    const rows = [v('GATE', 'shadow', 100)];
    const stats = new Map([['GATE', { pfe_wr: 0.95, buy_sell_count: 500, days_since: 90 }]]);
    expect(venueVerdict(rows[0], stats.get('GATE')!).qualified).toBe(true);
    expect(isDigestActionable(rows, stats).actionable).toBe(true);
  });

  it('SENDS when a venue is ⚠️ below the 80% bar — the case that keeps the digest useful', () => {
    const rows = [v('GATE', 'shadow', 100)];
    const stats = new Map([['GATE', { pfe_wr: 0.55, buy_sell_count: 500, days_since: 90 }]]);
    expect(venueVerdict(rows[0], stats.get('GATE')!).glyph).toBe('⚠️');
    const only = isDigestActionable(rows, stats);
    expect(only.actionable).toBe(true);
    expect(only.reason).toMatch(/1 below-bar/);
  });

  it('🔌 "no pipeline yet" CONTRIBUTES NOTHING to actionability (estate ruled it silent)', () => {
    // 🔌 is only reachable for a SHADOW venue (promoted/retired short-circuit earlier), and shadow
    // is actionable on its own — so the honest assertion is that 🔌 adds nothing: it is counted
    // neither as qualified nor as below-bar. New-Venue-SOP Phase 1: a starved venue "fires no
    // operator alert and burns no extension".
    const row = v('GATE', 'shadow', 100);
    const stats = new Map([['GATE', { pfe_wr: null, buy_sell_count: 0, days_since: 0 }]]);
    expect(venueVerdict(row, stats.get('GATE')!).glyph).toBe('🔌');
    const res = isDigestActionable([row], stats);
    expect(res.reason).toMatch(/0 qualified/);
    expect(res.reason).toMatch(/0 below-bar/);
    expect(res.reason).toMatch(/1 shadow/);   // the ONLY reason it sends
  });

  it('the reason string names all three counters, so a suppressed run is diagnosable from the log', () => {
    const rows = [promotedFine('HL')];
    const res = isDigestActionable(rows, new Map([['HL', okStats]]));
    expect(res.reason).toMatch(/shadow/);
    expect(res.reason).toMatch(/qualified/);
    expect(res.reason).toMatch(/below-bar/);
  });
});
