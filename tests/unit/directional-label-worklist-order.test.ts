import { describe, it, expect } from 'vitest';

// OPS-BDIR-V3-PANEL-READINESS-W1 CH2 — WHICH rows the nightly labeler reaches, never WHAT label.
//
// Measured 2026-09-26: the worklist was `ORDER BY exchange, coin, timeframe` walked under a
// 45-minute venue slice, so on every capacity-short venue the labelled set was an ALPHABETICAL COIN
// PREFIX (HL reached ~149 of ~541 groups a visit), and on venues whose candle endpoint serves only
// days of sub-1h history the skipped rows crossed that horizon and became permanently unlabelable
// (57,053 such rows counted across venues). Architect ruling Q-F (2026-09-26): horizon-first, then
// breadth; FULL-eligible venues first.

import {
  orderGroupsForVenue,
  orderVenuesFullPanelFirst,
  buildGroupsSql,
  CRITICAL_HORIZON_MARGIN_S,
  worklistPreamble,
  type PrioritizedGroup,
} from '../../src/scripts/backfill-directional-labels.js';
import { candleHorizonDays, CANDLE_HORIZON_DAYS, CANDLE_HORIZONS_MEASURED_AT } from '../../src/lib/venue-candle-horizons.js';
import { FULL_PANEL_VENUES, MAJOR_VENUES } from '../../src/lib/venue-slo-tiers.js';

const NOW = 1_790_420_000; // seconds
const H = 3600;
const D = 86_400;

function g(coin: string, timeframe: string, todoAgeH: number | null, over: Partial<PrioritizedGroup> = {}): PrioritizedGroup {
  return {
    exchange: 'GATE',
    coin,
    timeframe,
    todoOldest: todoAgeH === null ? null : NOW - Math.round(todoAgeH * H),
    todoLabelable: todoAgeH === null ? 0 : 5,
    todoPastHorizon: 0,
    ...over,
  };
}
const ids = (gs: PrioritizedGroup[]): string[] => gs.map((x) => `${x.coin}:${x.timeframe}`);

describe('orderGroupsForVenue — breadth, not an alphabetical prefix', () => {
  it('round-robins coins: every coin gets its first group before any coin gets a second', () => {
    const out = orderGroupsForVenue([
      g('AAVE', '5m', 10), g('AAVE', '1h', 9),
      g('BTC', '5m', 10), g('BTC', '1h', 9),
      g('ZEC', '5m', 10), g('ZEC', '1h', 9),
    ], NOW);
    // round 0 = one group per coin; round 1 = the rest — ZEC is no longer last-by-alphabet
    expect(ids(out).slice(0, 3).map((s) => s.split(':')[0]).sort()).toEqual(['AAVE', 'BTC', 'ZEC']);
    expect(new Set(ids(out).slice(3).map((s) => s.split(':')[0]))).toEqual(new Set(['AAVE', 'BTC', 'ZEC']));
  });

  it("within a round, the coin whose oldest unlabelled row is oldest goes first", () => {
    const out = orderGroupsForVenue([g('AAVE', '5m', 5), g('ZEC', '5m', 40), g('BTC', '5m', 20)], NOW);
    expect(ids(out)).toEqual(['ZEC:5m', 'BTC:5m', 'AAVE:5m']);
  });

  it("each coin's own groups are taken oldest-backlog first", () => {
    const out = orderGroupsForVenue([g('ETH', '5m', 2), g('ETH', '4h', 30), g('ETH', '1h', 12)], NOW);
    expect(ids(out)).toEqual(['ETH:4h', 'ETH:1h', 'ETH:5m']);
  });

  it('groups with nothing labelable to do go LAST (kept, never dropped — partial specs still complete)', () => {
    const out = orderGroupsForVenue([g('AAVE', '5m', null), g('ZEC', '5m', 1)], NOW);
    expect(ids(out)).toEqual(['ZEC:5m', 'AAVE:5m']);
    expect(out).toHaveLength(2);
  });

  it('is deterministic: the same input in any order yields the same output', () => {
    const input = [g('AAVE', '5m', 10), g('BTC', '5m', 10), g('BTC', '1h', 3), g('ZEC', '15m', 7), g('ETH', '5m', null)];
    const a = ids(orderGroupsForVenue(input, NOW));
    const b = ids(orderGroupsForVenue([...input].reverse(), NOW));
    expect(a).toEqual(b);
  });
});

describe('orderGroupsForVenue — horizon-first', () => {
  it('a group about to cross its venue candle horizon jumps ahead of breadth, whatever its coin', () => {
    // HL 5m serves 17.48 d of history (measured 2026-09-26): a row 17 d old is lost tomorrow.
    const near = { exchange: 'HL', coin: 'ZRO', timeframe: '5m', todoOldest: NOW - 17 * D, todoLabelable: 3, todoPastHorizon: 0 };
    const far = { exchange: 'HL', coin: 'AAVE', timeframe: '1h', todoOldest: NOW - 20 * D, todoLabelable: 40, todoPastHorizon: 0 };
    const out = orderGroupsForVenue([far, near], NOW);
    expect(ids(out)).toEqual(['ZRO:5m', 'AAVE:1h']);
  });

  it('the critical tier is ordered by time left before the horizon, nearest first', () => {
    const a = { exchange: 'PHEMEX', coin: 'AAA', timeframe: '3m', todoOldest: NOW - Math.round(3.1 * D), todoLabelable: 1, todoPastHorizon: 0 };
    const b = { exchange: 'PHEMEX', coin: 'BBB', timeframe: '15m', todoOldest: NOW - Math.round(10 * D), todoLabelable: 1, todoPastHorizon: 0 };
    // PHEMEX 3m depth 3.25 d → 0.15 d left; 15m depth 10.25 d → 0.25 d left
    expect(ids(orderGroupsForVenue([b, a], NOW))).toEqual(['AAA:3m', 'BBB:15m']);
  });

  it('a deep-history pair is never critical, however old its backlog', () => {
    const deep = { exchange: 'BINANCE', coin: 'ZEC', timeframe: '5m', todoOldest: NOW - 20 * D, todoLabelable: 9, todoPastHorizon: 0 };
    const other = { exchange: 'BINANCE', coin: 'AAVE', timeframe: '5m', todoOldest: NOW - 21 * D, todoLabelable: 9, todoPastHorizon: 0 };
    // pure breadth: the older backlog first, no critical promotion
    expect(ids(orderGroupsForVenue([deep, other], NOW))).toEqual(['AAVE:5m', 'ZEC:5m']);
  });

  it('the critical margin is at least one nightly interval (a row lost before the next run is critical now)', () => {
    expect(CRITICAL_HORIZON_MARGIN_S).toBeGreaterThanOrEqual(24 * H);
  });
});

describe('orderVenuesFullPanelFirst — the FULL-eligible venues are served before the rest', () => {
  it('every FULL-eligible venue precedes every other venue, whatever their staleness', () => {
    const frontier = new Map<string, number>([['KUCOIN', NOW - 1 * H], ['HL', NOW - 80 * H], ['GATE', 0], ['OKX', NOW - 2 * H]]);
    const order = orderVenuesFullPanelFirst(['GATE', 'HL', 'KUCOIN', 'OKX', 'MEXC'], frontier, NOW);
    const lastFull = Math.max(...order.map((v, i) => (FULL_PANEL_VENUES as readonly string[]).includes(v) ? i : -1));
    const firstOther = Math.min(...order.map((v, i) => (FULL_PANEL_VENUES as readonly string[]).includes(v) ? Infinity : i));
    expect(lastFull).toBeLessThan(firstOther);
    expect(new Set(order)).toEqual(new Set(['GATE', 'HL', 'KUCOIN', 'OKX', 'MEXC']));
  });
});

describe('the FULL-eligible set and the measured horizons', () => {
  it('is exactly the ruled set (Q-F, 2026-09-26) — HL is out (rule d, candle horizon)', () => {
    expect([...FULL_PANEL_VENUES].sort()).toEqual(['BINANCE', 'BITGET', 'BYBIT', 'KUCOIN', 'OKX']);
    expect(FULL_PANEL_VENUES as readonly string[]).not.toContain('HL');
  });

  it('every FULL-eligible venue except KUCOIN is a freshness major', () => {
    for (const v of FULL_PANEL_VENUES) if (v !== 'KUCOIN') expect(MAJOR_VENUES as readonly string[]).toContain(v);
  });

  it('an unmeasured pair is treated as deep, never as zero history', () => {
    expect(candleHorizonDays('BINANCE', '5m')).toBe(Infinity);
    expect(candleHorizonDays('NOPE', '5m')).toBe(Infinity);
    expect(candleHorizonDays('HL', '5m')).toBeCloseTo(17.48, 2);
  });

  it('every listed horizon is positive and shorter than the 21-day nightly reach (else it would not be listed)', () => {
    for (const [venue, tfs] of Object.entries(CANDLE_HORIZON_DAYS)) {
      for (const [tf, days] of Object.entries(tfs)) {
        expect(days, `${venue} ${tf}`).toBeGreaterThan(0);
        expect(days, `${venue} ${tf}`).toBeLessThan(21);
      }
    }
  });
});

describe('buildGroupsSql — the eligibility is the labeler’s own, the order data is new', () => {
  const { text: sql, params } = buildGroupsSql({ lookbackCutoff: NOW - 21 * D, nowSec: NOW });

  it('inlines only computed integers; a CLI string stays a bound parameter', () => {
    expect(params).toEqual([]);
    const scoped = buildGroupsSql({ lookbackCutoff: 0, nowSec: NOW, venue: "HL'; DROP TABLE x;--" });
    expect(scoped.params).toEqual(["HL'; DROP TABLE x;--"]);
    expect(scoped.text).toContain('s.exchange = $1');
    expect(scoped.text).not.toContain('DROP TABLE');
  });

  it("keeps processGroup's eligibility filters verbatim (BUY/SELL, pfe present, no 1m, not retired, lookback)", () => {
    expect(sql).toContain("s.signal IN ('BUY','SELL')");
    expect(sql).toContain('s.pfe_return_pct IS NOT NULL');
    expect(sql).toContain("s.timeframe <> '1m'");
    expect(sql).toContain("s.exchange NOT IN (SELECT exchange_id FROM venues WHERE status = 'retired')");
    expect(sql).toContain(`s.created_at > ${NOW - 21 * D}`);
  });

  it('counts todo on the primary spec only, via a LEFT JOIN (a group with no labels still appears)', () => {
    expect(sql).toContain("LEFT JOIN directional_labels d ON d.signal_id = s.id AND d.barrier_spec = 'tau1.0-floor0.30-v1'");
  });

  it('carries every measured short horizon as a cut-off, so past-horizon rows are counted apart', () => {
    for (const [venue, tfs] of Object.entries(CANDLE_HORIZON_DAYS)) {
      for (const tf of Object.keys(tfs)) expect(sql).toContain(`('${venue}', '${tf}', `);
    }
    expect(sql).toMatch(/todo_past_horizon/);
  });
});

describe('worklistPreamble — the run log names the order it used', () => {
  // A horizon table goes stale when a venue changes its retention; the log line is how a reader of
  // any night's run knows WHICH measured table and WHICH FULL set ordered it.
  it('names the horizon measurement date, the critical margin and the FULL-eligible set', () => {
    const line = worklistPreamble();
    expect(line.startsWith('[worklist] ')).toBe(true);
    expect(line).toContain(`horizons_measured=${CANDLE_HORIZONS_MEASURED_AT}`);
    expect(line).toContain(`critical_margin_h=${CRITICAL_HORIZON_MARGIN_S / 3600}`);
    expect(line).toContain(`full_panel=${FULL_PANEL_VENUES.join(',')}`);
  });
});
