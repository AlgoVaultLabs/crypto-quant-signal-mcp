/**
 * tests/unit/venue-readiness-report.test.ts — OPS-SHADOW-PIPELINE-W1 / C5.
 * Pure buildReport/venueVerdict: all-17 coverage, READY-TO-LAUNCH block,
 * per-state glyphs, PFE-WR-only (no outcome_return_pct/Phase-E leakage).
 */
import { describe, it, expect } from 'vitest';
import { buildReport, venueVerdict } from '../../src/scripts/venue-readiness-report.js';
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

describe('venueVerdict — per-state glyphs (C5)', () => {
  it('classifies every readiness state', () => {
    expect(venueVerdict(v('A', 'promoted'), { pfe_wr: null, buy_sell_count: 0, days_since: 0 }).line).toContain('already live');
    expect(venueVerdict(v('B', 'shadow'), { pfe_wr: null, buy_sell_count: 0, days_since: 0 }).line).toContain('no pipeline yet');
    expect(venueVerdict(v('C', 'shadow'), { pfe_wr: null, buy_sell_count: 50, days_since: 3 }).line).toContain('within initial window');
    expect(venueVerdict(v('D', 'shadow'), { pfe_wr: null, buy_sell_count: 50, days_since: 20 }).line).toContain('WR n/a');
    expect(venueVerdict(v('E', 'shadow'), { pfe_wr: 0.9, buy_sell_count: 400, days_since: 20 }).line).toContain('need 100 more');
    expect(venueVerdict(v('F', 'shadow'), { pfe_wr: 0.65, buy_sell_count: 600, days_since: 20 }).line).toContain('< 80%');
    const q = venueVerdict(v('G', 'shadow'), { pfe_wr: 0.85, buy_sell_count: 600, days_since: 20 });
    expect(q.qualified).toBe(true);
    expect(q.line).toContain('QUALIFIED');
  });
});
