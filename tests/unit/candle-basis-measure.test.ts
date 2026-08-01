/**
 * candle-basis-measure.test.ts — SIGNAL-CLOSEDBAR-SHADOW-W1 CH4 AC5
 *
 * The aggregation helpers, against a 10-row fixture whose every expected number is
 * HAND-COMPUTED in the table below rather than snapshotted from the code. A snapshot would
 * only prove the helpers are self-consistent; the flip wave is going to retune live
 * thresholds off these numbers, so they have to be right, not merely stable.
 *
 * No live DB — `performance-db` is mocked purely so importing the module cannot reach one.
 *
 * ── The fixture, and every expectation derived from it by hand ────────────────
 *  #  tf    live  closed  elapsed  confL confC  volL  volC  rawL  rawC  day
 *  1  1h    HOLD  BUY     0.05      40    62    -70    50    20    55   08-01
 *  2  1h    HOLD  HOLD    0.15      30    32    -70   -30    10    18   08-01
 *  3  1h    BUY   HOLD    0.95      55    41     10   -70    45    30   08-01
 *  4  4h    SELL  HOLD    0.45      60    50    -70    80   -50   -35   08-02
 *  5  4h    HOLD  SELL    0.05      35    58    -70   100    15    52   08-02
 *  6  4h    HOLD  HOLD    null      30    30     50    50     5     5   08-02
 *  7  15m   BUY   SELL    0.25      45    47    -70   -70    42   -41   08-03
 *  8  15m   SELL  BUY     0.35      50    44    -70    10   -48    44   08-03
 *  9  15m   HOLD  (throw) 0.55      33   null   -70  null    12  null   08-03
 * 10  15m   BUY   BUY     0.65      70    72     80    80    60    62   08-03
 *
 *  comparable = 9 (row 9's closed pass threw)   flipped = rows 1,3,4,5,7,8 = 6
 *  flip rate  = 6/9                             each of the six transitions occurs once
 *  vol floor  live 7/10 · closed 2/9            max|raw| live 60 · closed 62
 *  conf delta [-14,-10,-6,0,2,2,2,22,23] ⇒ sum 21, mean 21/9, p50 2, p95 23
 */
import { describe, it, expect, vi } from 'vitest';

// Mocked only so importing the module under test cannot open a database.
vi.mock('../../src/lib/performance-db.js', () => ({ dbQuery: vi.fn().mockResolvedValue([]) }));

import {
  decileOf,
  DECILE_LABELS,
  transitionKey,
  TRANSITIONS,
  flipStats,
  percentile,
  deltaStats,
  volScoreStats,
  verdictVolume,
  groupBy,
  utcDay,
  readiness,
  verdictLine,
  parseSeededTfs,
  buildReport,
  renderMarkdown,
  normalizeRow,
  VOL_SCORE_FLOOR,
  READINESS_MIN_ROWS,
  READINESS_MIN_DAYS,
  READINESS_MIN_ROWS_PER_TF,
  type ShadowRow,
} from '../../src/scripts/candle-basis-measure.js';

type Spec = [string, string, string | null, number | null, number, number | null,
             number | null, number | null, number | null, number | null, string];

const SPECS: Spec[] = [
  ['1h', 'HOLD', 'BUY', 0.05, 40, 62, -70, 50, 20, 55, '2026-08-01'],
  ['1h', 'HOLD', 'HOLD', 0.15, 30, 32, -70, -30, 10, 18, '2026-08-01'],
  ['1h', 'BUY', 'HOLD', 0.95, 55, 41, 10, -70, 45, 30, '2026-08-01'],
  ['4h', 'SELL', 'HOLD', 0.45, 60, 50, -70, 80, -50, -35, '2026-08-02'],
  ['4h', 'HOLD', 'SELL', 0.05, 35, 58, -70, 100, 15, 52, '2026-08-02'],
  ['4h', 'HOLD', 'HOLD', null, 30, 30, 50, 50, 5, 5, '2026-08-02'],
  ['15m', 'BUY', 'SELL', 0.25, 45, 47, -70, -70, 42, -41, '2026-08-03'],
  ['15m', 'SELL', 'BUY', 0.35, 50, 44, -70, 10, -48, 44, '2026-08-03'],
  ['15m', 'HOLD', null, 0.55, 33, null, -70, null, 12, null, '2026-08-03'],
  ['15m', 'BUY', 'BUY', 0.65, 70, 72, 80, 80, 60, 62, '2026-08-03'],
];

const FIXTURE: ShadowRow[] = SPECS.map(
  ([tf, live, closed, elapsed, cl, cc, vl, vc, rl, rc, day]) => ({
    tool: 'get_trade_call',
    timeframe: tf,
    call_live: live,
    call_closed: closed,
    error_class: closed === null ? 'InsufficientCandlesError' : null,
    conf_live: cl,
    conf_closed: cc,
    raw_live: rl,
    raw_closed: rc,
    vol_score_live: vl,
    vol_score_closed: vc,
    pivot_quality_live: null,
    pivot_quality_closed: null,
    elapsed_fraction: elapsed,
    recorded_at: `${day}T12:00:00Z`,
  }),
);

const SEEDED = ['1h', '4h', '15m'];

describe('CH4 — candle-basis-measure aggregation helpers', () => {
  it('the fixture itself matches the hand-computed table (non-vacuity)', () => {
    expect(FIXTURE).toHaveLength(10);
    expect(FIXTURE.filter((r) => r.call_closed === null)).toHaveLength(1);
    expect(new Set(FIXTURE.map((r) => utcDay(r.recorded_at))).size).toBe(3);
  });

  // ── deciles, incl. the explicit NULL bucket (AC4) ──────────────────────────
  it('buckets elapsed fraction into deciles with NULL as its own bucket', () => {
    expect(decileOf(0.05)).toBe('0-10');
    expect(decileOf(0.15)).toBe('10-20');
    expect(decileOf(0.95)).toBe('90-100');
    expect(decileOf(0)).toBe('0-10');
    expect(decileOf(null)).toBe('NULL');
    expect(decileOf(undefined)).toBe('NULL');
    expect(decileOf(Number.NaN)).toBe('NULL');
    // Clamped, so a 1.0 (or a clock-skew 1.02) never creates an 11th bucket.
    expect(decileOf(1)).toBe('90-100');
    expect(decileOf(1.02)).toBe('90-100');
    expect(DECILE_LABELS).toHaveLength(11);
    expect(DECILE_LABELS[DECILE_LABELS.length - 1]).toBe('NULL');
  });

  // ── flip rate — the headline number, hand-computed ─────────────────────────
  it('computes the hand-computed flip rate 6/9 and one of each transition', () => {
    const f = flipStats(FIXTURE);
    expect(f.n).toBe(10);
    expect(f.nComparable).toBe(9); // row 9 threw, so it is not comparable
    expect(f.nFlipped).toBe(6);
    expect(f.flipRate).toBeCloseTo(6 / 9, 12);
    for (const t of TRANSITIONS) expect(f.transitions[t], t).toBe(1);
    expect(f.errorsByClass).toEqual({ InsufficientCandlesError: 1 });
  });

  it('a throw is never counted as a flip, and never inflates the denominator', () => {
    const f = flipStats(FIXTURE);
    // 6/9, NOT 6/10 — dividing by n would understate the flip rate by ~7 points here.
    expect(f.flipRate).not.toBeCloseTo(6 / 10, 6);
    expect(transitionKey('HOLD', null)).toBeNull();
    expect(transitionKey('BUY', 'BUY')).toBeNull();
    expect(transitionKey('HOLD', 'BUY')).toBe('HOLD->BUY');
  });

  // ── distributions ──────────────────────────────────────────────────────────
  it('computes nearest-rank percentiles and returns null on empty input', () => {
    const s = [-14, -10, -6, 0, 2, 2, 2, 22, 23];
    expect(percentile(s, 50)).toBe(2);
    expect(percentile(s, 95)).toBe(23);
    expect(percentile(s, 0)).toBe(-14);
    expect(percentile(s, 100)).toBe(23);
    expect(percentile([], 50)).toBeNull();
  });

  it('computes the hand-computed confidence delta distribution', () => {
    const deltas = FIXTURE
      .filter((r) => r.conf_live !== null && r.conf_closed !== null)
      .map((r) => (r.conf_closed as number) - (r.conf_live as number));
    expect(deltas).toEqual([22, 2, -14, -10, 23, 0, 2, -6, 2]);

    const d = deltaStats(deltas);
    expect(d.n).toBe(9);
    expect(d.mean).toBeCloseTo(21 / 9, 12);
    expect(d.p50).toBe(2);
    expect(d.p95).toBe(23);
    expect(d.min).toBe(-14);
    expect(d.max).toBe(23);
    expect(deltaStats([])).toMatchObject({ n: 0, mean: null, p50: null, p95: null });
  });

  it('computes the volume-score floor rate per basis and the reachable raw ceiling', () => {
    const live = volScoreStats(FIXTURE.map((r) => r.vol_score_live), FIXTURE.map((r) => r.raw_live));
    expect(live.n).toBe(10);
    expect(live.floorCount).toBe(7);
    expect(live.floorRate).toBeCloseTo(0.7, 12);
    expect(live.maxAbsRaw).toBe(60);
    expect(live.histogram[String(VOL_SCORE_FLOOR)]).toBe(7);

    const closed = volScoreStats(FIXTURE.map((r) => r.vol_score_closed), FIXTURE.map((r) => r.raw_closed));
    expect(closed.n).toBe(9); // the throw contributed no closed-basis score
    expect(closed.floorCount).toBe(2);
    expect(closed.floorRate).toBeCloseTo(2 / 9, 12);
    expect(closed.maxAbsRaw).toBe(62);
  });

  it('counts projected verdict volume per basis rather than re-deriving verdicts', () => {
    const v = verdictVolume(FIXTURE);
    expect(v.live).toEqual({ BUY: 3, SELL: 2, HOLD: 5 });
    expect(v.closed).toEqual({ BUY: 3, SELL: 2, HOLD: 4 }); // 9, not 10 — the throw
  });

  // ── readiness (AC2/AC3) ────────────────────────────────────────────────────
  it('parses --seeded-tfs and never invents a default', () => {
    expect(parseSeededTfs(['--seeded-tfs=1h,4h'])).toEqual(['1h', '4h']);
    expect(parseSeededTfs(['--seeded-tfs= 1h , 4h '])).toEqual(['1h', '4h']);
    expect(parseSeededTfs([])).toBeNull();
    expect(parseSeededTfs(['--seeded-tfs='])).toBeNull();
    expect(parseSeededTfs(['--format=json'])).toBeNull();
  });

  it('AC3: an absent --seeded-tfs is its OWN reason, not a silent pass', () => {
    const r = readiness(FIXTURE, null);
    expect(r.ready).toBe(false);
    expect(r.reasons[0]).toBe('seeded_tfs_not_supplied');
    expect(verdictLine(r)).toContain('CANDLE_BASIS_FLIP_NOT_READY');
    expect(verdictLine(r)).toContain('seeded_tfs_not_supplied');
  });

  it('AC2: an EMPTY table yields NOT_READY with reasons, never a throw', () => {
    const r = readiness([], SEEDED);
    expect(r.ready).toBe(false);
    expect(r.nRows).toBe(0);
    expect(r.distinctDays).toBe(0);
    expect(r.reasons.join(';')).toContain(`n_rows=0<${READINESS_MIN_ROWS}`);
    expect(r.reasons.join(';')).toContain(`distinct_utc_days=0<${READINESS_MIN_DAYS}`);
    expect(r.reasons.join(';')).toContain(`tf_below_${READINESS_MIN_ROWS_PER_TF}`);
  });

  it('the readiness formula is a conjunction — each clause alone blocks READY', () => {
    const many = (n: number, tf: string, day: string): ShadowRow[] =>
      Array.from({ length: n }, () => ({ ...FIXTURE[0], timeframe: tf, recorded_at: `${day}T00:00:00Z` }));

    // Enough rows and enough per-tf, but only 1 distinct day.
    const oneDay = [...many(200, '1h', '2026-08-01'), ...many(200, '4h', '2026-08-01'),
                    ...many(200, '15m', '2026-08-01')];
    expect(readiness(oneDay, SEEDED).ready).toBe(false);
    expect(readiness(oneDay, SEEDED).reasons.join(';')).toContain('distinct_utc_days=1');

    // 7 days and >=500 rows, but one seeded tf is starved. The per-tf floor is a WINDOW
    // total, not a per-day one — 2/day over 7 days is 14, below the floor of 20.
    const days = Array.from({ length: 7 }, (_, i) => `2026-08-0${i + 1}`);
    const spread = days.flatMap((d) => [...many(40, '1h', d), ...many(40, '4h', d), ...many(2, '15m', d)]);
    expect(spread.length).toBeGreaterThanOrEqual(READINESS_MIN_ROWS);
    const rSpread = readiness(spread, SEEDED);
    expect(rSpread.perTf['15m']).toBe(14);
    expect(rSpread.ready).toBe(false);
    expect(rSpread.reasons.join(';')).toContain('15m=14');
    // …and the other two are NOT named, so the reason points at the real culprit.
    expect(rSpread.reasons.join(';')).not.toContain('1h=');

    // All three clauses satisfied ⇒ READY. Proves the gate can actually open.
    const ok = days.flatMap((d) => [...many(30, '1h', d), ...many(30, '4h', d), ...many(30, '15m', d)]);
    const rOk = readiness(ok, SEEDED);
    expect(rOk.ready).toBe(true);
    expect(rOk.reasons).toEqual([]);
    expect(verdictLine(rOk)).toMatch(/^CANDLE_BASIS_FLIP_READY: /);
  });

  it('a timeframe outside seeded_tfs never blocks readiness', () => {
    const days = Array.from({ length: 7 }, (_, i) => `2026-08-0${i + 1}`);
    const rows = days.flatMap((d) =>
      Array.from({ length: 80 }, (_, i) => ({
        ...FIXTURE[0],
        timeframe: i < 75 ? '1h' : '3m', // 3m is EXPOSED-but-not-SEEDED
        recorded_at: `${d}T00:00:00Z`,
      })));
    expect(readiness(rows, ['1h']).ready).toBe(true);
  });

  // ── report assembly ────────────────────────────────────────────────────────
  it('AC4: the report carries the timeframe, decile and NULL-decile slices', () => {
    const rep = buildReport(FIXTURE, SEEDED, '2026-08-04T00:00:00Z', null);
    expect(Object.keys(rep.by_timeframe).sort()).toEqual(['15m', '1h', '4h']);
    expect(rep.by_timeframe['1h'].n).toBe(3);
    expect(rep.by_timeframe['4h'].n).toBe(3);
    expect(rep.by_timeframe['15m'].n).toBe(4);

    expect(Object.keys(rep.by_decile).sort()).toEqual([...DECILE_LABELS].sort());
    expect(rep.by_decile['0-10'].n).toBe(2);
    expect(rep.by_decile['90-100'].n).toBe(1);
    expect(rep.null_decile_n).toBe(1);
    expect(rep.by_decile['NULL'].n).toBe(1);
    // Every row lands in exactly one bucket.
    expect(DECILE_LABELS.reduce((s, l) => s + rep.by_decile[l].n, 0)).toBe(FIXTURE.length);

    expect(rep.window).toEqual({ first: '2026-08-01T12:00:00Z', last: '2026-08-03T12:00:00Z' });
    expect(rep.by_tool).toEqual({ get_trade_call: 10 });
  });

  it('emits a daily timeseries, not just aggregates', () => {
    const rep = buildReport(FIXTURE, SEEDED, '2026-08-04T00:00:00Z', null);
    expect(rep.daily.map((d) => d.day)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
    expect(rep.daily.map((d) => d.n)).toEqual([3, 3, 4]);
    expect(rep.daily.map((d) => d.n_flipped)).toEqual([2, 2, 2]);
    expect(rep.daily[2].flip_rate).toBeCloseTo(2 / 3, 12); // 3 comparable on 08-03, not 4
  });

  it('renders markdown whose LAST line is never the verdict (the caller appends it)', () => {
    const rep = buildReport(FIXTURE, SEEDED, '2026-08-04T00:00:00Z', null);
    const md = renderMarkdown(rep);
    expect(md).toContain('## By elapsed-fraction decile');
    expect(md).toContain('null_decile_n: 1');
    expect(md).toContain('| 15m | 4 |');
    expect(md).not.toContain('CANDLE_BASIS_FLIP_');
  });

  it('renders an empty window without throwing and still reports zeros', () => {
    const rep = buildReport([], null, '2026-08-04T00:00:00Z', 'error: relation does not exist');
    expect(() => renderMarkdown(rep)).not.toThrow();
    expect(rep.n_rows).toBe(0);
    expect(rep.load_error).toContain('does not exist');
    expect(verdictLine(rep.readiness)).toContain('seeded_tfs_not_supplied');
  });

  it('a load error can never produce a READY verdict', () => {
    const rep = buildReport([], ['1h'], '2026-08-04T00:00:00Z', 'boom');
    expect(rep.readiness.ready).toBe(false);
  });

  // ── row hydration ──────────────────────────────────────────────────────────
  it('coerces pg NUMERIC strings to numbers and preserves nulls', () => {
    const r = normalizeRow({
      tool: null, timeframe: '1h', call_live: 'BUY', call_closed: null, error_class: 'E',
      conf_live: 55, conf_closed: null, raw_live: '41.5', raw_closed: null,
      vol_score_live: '-70', vol_score_closed: null,
      pivot_quality_live: '0.477', pivot_quality_closed: null,
      elapsed_fraction: '0.1', recorded_at: '2026-08-01T00:00:00Z',
    });
    expect(r.raw_live).toBe(41.5);
    expect(r.vol_score_live).toBe(-70);
    expect(r.pivot_quality_live).toBeCloseTo(0.477, 12);
    expect(r.elapsed_fraction).toBeCloseTo(0.1, 12);
    expect(r.conf_closed).toBeNull();
    expect(r.raw_closed).toBeNull();
    // A legacy pre-CH3 row has no `tool`; the report attributes it to get_trade_call.
    expect(r.tool).toBeNull();
    expect(buildReport([r], null, 'x', null).by_tool).toEqual({ get_trade_call: 1 });
  });

  it('groupBy and utcDay behave on the fixture', () => {
    expect([...groupBy(FIXTURE, (r) => r.timeframe).keys()].sort()).toEqual(['15m', '1h', '4h']);
    expect(utcDay('2026-08-01T12:00:00Z')).toBe('2026-08-01');
  });
});
