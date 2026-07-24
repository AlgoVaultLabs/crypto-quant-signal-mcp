/**
 * OPS-DIRECTIONAL-LABEL-HALT-W1 — the generator-fix battery.
 *
 * Incident class: silent per-venue starvation (alphabetical full pass never
 * survived to the tail; 8 venues dead 16 days). These tests pin the structural
 * guarantees: stalest-first rotation, clean-exit budgets, per-venue isolation,
 * the nightly recency window, and orchestrator flag passthrough.
 */
import { describe, expect, it } from 'vitest';
import {
  detectCapacityShortfall,
  lookbackCutoff,
  makeBudget,
  orderVenuesBySloDeadline,
  orderVenuesByStaleness,
  parseCli,
  partitionByVenue,
  runVenueRotation,
} from '../../src/scripts/backfill-directional-labels.js';
import { buildSteps } from '../../src/scripts/nightly-carry-labeler.js';

const G = (exchange: string, coin = 'BTC', timeframe = '5m') => ({ exchange, coin, timeframe });

describe('parseCli (new flags)', () => {
  it('parses timeframe, lookback and budgets', () => {
    const cli = parseCli(['--timeframe', '5m', '--lookback-days', '21', '--time-budget-min', '210', '--venue-budget-min', '45']);
    expect(cli.timeframe).toBe('5m');
    expect(cli.lookbackDays).toBe(21);
    expect(cli.timeBudgetMin).toBe(210);
    expect(cli.venueBudgetMin).toBe(45);
  });

  it('defaults stay full-depth/unbounded (backfill semantics unchanged)', () => {
    const cli = parseCli([]);
    expect(cli.lookbackDays).toBeUndefined();
    expect(cli.timeBudgetMin).toBeUndefined();
    expect(cli.venueBudgetMin).toBeUndefined();
  });

  it('default-denies malformed bounds instead of silently meaning unbounded', () => {
    expect(() => parseCli(['--lookback-days', 'banana'])).toThrow(/invalid --lookback-days/);
    expect(() => parseCli(['--time-budget-min', '-5'])).toThrow(/invalid --time-budget-min/);
    expect(() => parseCli(['--venue-budget-min', '0'])).toThrow(/invalid --venue-budget-min/);
  });
});

describe('lookbackCutoff', () => {
  it('bounds the window inclusively at now − N days; 0 when unset', () => {
    const nowMs = 1_800_000_000_000;
    expect(lookbackCutoff({ lookbackDays: 21 }, nowMs)).toBe(1_800_000_000 - 21 * 86_400);
    expect(lookbackCutoff({}, nowMs)).toBe(0);
  });
});

describe('orderVenuesByStaleness (F1)', () => {
  it('puts the most-starved venue FIRST and never-labeled before everything', () => {
    const frontier = new Map([
      ['BINANCE', 1_800_000_000],
      ['OKX', 1_798_000_000], // stale
      ['HTX', 1_797_000_000], // stalest labeled
    ]);
    // PHEMEX absent from the frontier map = never labeled → frontier 0 → first
    const order = orderVenuesByStaleness(['BINANCE', 'PHEMEX', 'OKX', 'HTX'], frontier);
    expect(order).toEqual(['PHEMEX', 'HTX', 'OKX', 'BINANCE']);
  });

  it('ties break deterministically (alphabetical)', () => {
    const f = new Map([['B', 5], ['A', 5], ['C', 5]]);
    expect(orderVenuesByStaleness(['B', 'A', 'C'], f)).toEqual(['A', 'B', 'C']);
  });
});

describe('partitionByVenue', () => {
  it('groups by exchange preserving within-venue order', () => {
    const by = partitionByVenue([G('A', 'X'), G('B', 'Y'), G('A', 'Z')]);
    expect([...by.keys()]).toEqual(['A', 'B']);
    expect(by.get('A')!.map((g) => g.coin)).toEqual(['X', 'Z']);
  });
});

describe('runVenueRotation (F2/F4)', () => {
  const budgetless = () => makeBudget({});

  it('processes venues in the given order and reports complete summaries', async () => {
    const seen: string[] = [];
    const s = await runVenueRotation(
      ['HTX', 'OKX'],
      partitionByVenue([G('OKX', 'A'), G('HTX', 'B'), G('HTX', 'C')]),
      budgetless(),
      async (g) => { seen.push(`${g.exchange}:${g.coin}`); },
      () => {},
    );
    expect(seen).toEqual(['HTX:B', 'HTX:C', 'OKX:A']);
    expect(s.map((x) => [x.venue, x.outcome, x.groupsDone])).toEqual([
      ['HTX', 'complete', 2],
      ['OKX', 'complete', 1],
    ]);
  });

  it('a venue whose processor THROWS does not stop successors (isolation)', async () => {
    const seen: string[] = [];
    const s = await runVenueRotation(
      ['HTX', 'OKX'],
      partitionByVenue([G('HTX', 'B'), G('OKX', 'A')]),
      budgetless(),
      async (g) => {
        if (g.exchange === 'HTX') throw new Error('venue-level boom');
        seen.push(g.exchange);
      },
      () => {},
    );
    expect(seen).toEqual(['OKX']);
    expect(s[0]).toMatchObject({ venue: 'HTX', outcome: 'venue-error', groupsDone: 0 });
    expect(s[1]).toMatchObject({ venue: 'OKX', outcome: 'complete' });
  });

  it('global budget expiry mid-venue → clean stop, remaining venues untouched', async () => {
    let t = 0;
    const now = () => t;
    const budget = makeBudget({ timeBudgetMin: 1 }, now); // 60_000ms budget
    const seen: string[] = [];
    const s = await runVenueRotation(
      ['HTX', 'OKX'],
      partitionByVenue([G('HTX', 'A'), G('HTX', 'B'), G('HTX', 'C'), G('OKX', 'D')]),
      budget,
      async (g) => { seen.push(g.coin); t += 45_000; }, // budget crossed before group C
      () => {},
      now,
    );
    expect(seen).toEqual(['A', 'B']);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ venue: 'HTX', outcome: 'global-budget', groupsDone: 2 });
  });

  it('per-venue budget expiry moves ON to the next venue (tar-pit cap)', async () => {
    let t = 0;
    const now = () => t;
    const budget = makeBudget({ venueBudgetMin: 1 }, now);
    const seen: string[] = [];
    const s = await runVenueRotation(
      ['HL', 'HTX'],
      partitionByVenue([G('HL', 'A'), G('HL', 'B'), G('HL', 'C'), G('HTX', 'D')]),
      budget,
      async (g) => { seen.push(`${g.exchange}:${g.coin}`); t += 40_000; },
      () => {},
      now,
    );
    expect(seen).toEqual(['HL:A', 'HL:B', 'HTX:D']); // HL capped after 80s ≥ 60s check pre-C
    expect(s[0]).toMatchObject({ venue: 'HL', outcome: 'venue-budget', groupsDone: 2 });
    expect(s[1]).toMatchObject({ venue: 'HTX', outcome: 'complete', groupsDone: 1 });
  });

  it('emits the load-bearing per-venue summary with the extra suffix', async () => {
    const lines: string[] = [];
    await runVenueRotation(
      ['OKX'],
      partitionByVenue([G('OKX', 'A')]),
      budgetless(),
      async () => {},
      (l) => lines.push(l),
      Date.now,
      (v) => `written=7 frontier=test-${v}`,
    );
    expect(lines.some((l) => l.includes('[venue-summary] OKX') && l.includes('written=7 frontier=test-OKX'))).toBe(true);
  });
});

describe('nightly orchestrator passthrough (F3 wiring)', () => {
  it('the DWR step carries the nightly freshness bounds', () => {
    const label = buildSteps([])[2].args;
    for (const [flag, v] of [
      ['--lookback-days', '21'],
      ['--time-budget-min', '210'],
      ['--venue-budget-min', '45'],
    ] as const) {
      const i = label.indexOf(flag);
      expect(i, `${flag} missing`).toBeGreaterThan(-1);
      expect(label[i + 1]).toBe(v);
    }
  });

  it('funding steps do NOT receive the labeler-only flags', () => {
    const steps = buildSteps([]);
    for (const s of steps.slice(0, 2)) {
      expect(s.args).not.toContain('--lookback-days');
      expect(s.args).not.toContain('--time-budget-min');
    }
  });
});

// ─────────────────── OPS-LABEL-FRESHNESS-W1 R2 — SLO-deadline rotation ───────────────────
describe('orderVenuesBySloDeadline (R2 — the H1 fix)', () => {
  const NOW = 1_800_000_000; // sec
  const h = (hrs: number) => NOW - hrs * 3600; // a frontier `hrs` hours old
  // majors 24h / long-tail 72h come from the shared SoT (venue-slo-tiers.ts) default.

  it('schedules a breaching MAJOR before a MORE-stale but in-SLO long-tail', () => {
    const frontier = new Map<string, number>([
      ['BINANCE', h(30)], // major: 30h old → 6h PAST its 24h SLO (t2b = −6h)
      ['ASTER', h(57)],   // long-tail: 57h → 15h of headroom under 72h (t2b = +15h)
      ['BINGX', h(55)],   // long-tail: 55h → +17h
    ]);
    // Raw staleness would order ASTER>BINGX>BINANCE (the incident); SLO-deadline flips it.
    expect(orderVenuesBySloDeadline(['ASTER', 'BINGX', 'BINANCE'], frontier, NOW)[0]).toBe('BINANCE');
  });

  it('orders purely by time-to-breach across mixed tiers', () => {
    const frontier = new Map<string, number>([
      ['BYBIT', h(20)], // major: t2b = 24−20 = +4h
      ['OKX', h(26)],   // major: t2b = −2h
      ['MEXC', h(70)],  // long-tail: t2b = 72−70 = +2h
      ['HTX', h(80)],   // long-tail: t2b = −8h
    ]);
    expect(orderVenuesBySloDeadline(['BYBIT', 'OKX', 'MEXC', 'HTX'], frontier, NOW))
      .toEqual(['HTX', 'OKX', 'MEXC', 'BYBIT']);
  });

  it('never-labeled (frontier absent) sorts first; ties break alphabetically', () => {
    const frontier = new Map<string, number>([['OKX', h(5)]]);
    const order = orderVenuesBySloDeadline(['OKX', 'ZED', 'ABE'], frontier, NOW);
    expect(order.slice(0, 2)).toEqual(['ABE', 'ZED']); // both never-labeled → before OKX, alpha tie
    expect(order[2]).toBe('OKX');
  });
});

describe('runVenueRotation circuit-breaker (R2 A2 — poison venue yields budget)', () => {
  it('trips a venue whose errors dominate writes, freeing budget for the next venue', async () => {
    let written = 0, errors = 0;
    const seen: string[] = [];
    const s = await runVenueRotation(
      ['POISON', 'HEALTHY'],
      partitionByVenue([
        ...Array.from({ length: 40 }, (_, i) => G('POISON', `c${i}`)),
        G('HEALTHY', 'H'),
      ]),
      makeBudget({}),
      async (g) => {
        seen.push(g.exchange);
        if (g.exchange === 'POISON') errors += 10; else written += 5; // poison only errors
      },
      () => {},
      Date.now,
      undefined,
      { progress: () => ({ written, errors }), circuit: { minGroupsBeforeTrip: 5, maxErrors: 50, errorToWriteRatio: 8 } },
    );
    expect(s[0]).toMatchObject({ venue: 'POISON', outcome: 'venue-circuit-break' });
    expect(s[0].groupsDone).toBeLessThan(40); // yielded early, did NOT burn the whole venue
    expect(s[1]).toMatchObject({ venue: 'HEALTHY', outcome: 'complete', groupsDone: 1 });
    expect(seen).toContain('HEALTHY');
  });

  it('never trips a venue that is writing labels (progress ⇒ healthy)', async () => {
    let written = 0, errors = 0;
    const s = await runVenueRotation(
      ['BUSY'],
      partitionByVenue(Array.from({ length: 40 }, (_, i) => G('BUSY', `c${i}`))),
      makeBudget({}),
      async () => { written += 5; errors += 1; }, // writes dominate errors
      () => {},
      Date.now,
      undefined,
      { progress: () => ({ written, errors }), circuit: { minGroupsBeforeTrip: 5, maxErrors: 10, errorToWriteRatio: 8 } },
    );
    expect(s[0]).toMatchObject({ venue: 'BUSY', outcome: 'complete', groupsDone: 40 });
  });
});

describe('runVenueRotation graceful-stop (R2 A1 — SIGTERM checkpoint at boundary)', () => {
  it('stops cleanly at the next group boundary and marks the venue "stopped"', async () => {
    let stop = false;
    const seen: string[] = [];
    const s = await runVenueRotation(
      ['V1', 'V2'],
      partitionByVenue([G('V1', 'A'), G('V1', 'B'), G('V1', 'C'), G('V2', 'D')]),
      makeBudget({}),
      async (g) => { seen.push(g.coin); if (g.coin === 'B') stop = true; }, // request stop after B
      () => {},
      Date.now,
      undefined,
      { stopRequested: () => stop },
    );
    expect(seen).toEqual(['A', 'B']); // C skipped (stop checked before it), V2 never started
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ venue: 'V1', outcome: 'stopped', groupsDone: 2 });
  });
});

describe('detectCapacityShortfall (R2 — capacity signal fires at the shortfall)', () => {
  const NOW = 1_800_000_000;
  const h = (hrs: number) => NOW - hrs * 3600;
  it('flags an UNREACHED venue that will breach before the next nightly', () => {
    const frontier = new Map<string, number>([
      ['BINANCE', h(2)],  // reached, fresh
      ['BITGET', h(20)],  // UNREACHED major: 20h + 24h next-run = 44h > 24h SLO → in danger
      ['MEXC', h(10)],    // UNREACHED long-tail: 10 + 24 = 34h < 72h → safe
    ]);
    const summaries = [{ venue: 'BINANCE', groupsDone: 5, groupsTotal: 5, outcome: 'complete' as const, elapsedS: 600 }];
    const cap = detectCapacityShortfall(summaries, ['BINANCE', 'BITGET', 'MEXC'], frontier, NOW);
    expect(cap.shortfall).toBe(true);
    expect(cap.unreachedInDanger).toEqual(['BITGET']);
    expect(cap.estVenueMinShort).toBeGreaterThan(0);
  });

  it('no shortfall when every unreached venue stays in-SLO until the next run', () => {
    const frontier = new Map<string, number>([['HL', h(1)], ['GATE', h(5)]]);
    const summaries = [{ venue: 'HL', groupsDone: 1, groupsTotal: 1, outcome: 'complete' as const, elapsedS: 60 }];
    const cap = detectCapacityShortfall(summaries, ['HL', 'GATE'], frontier, NOW);
    expect(cap.shortfall).toBe(false);
    expect(cap.unreachedInDanger).toEqual([]);
  });
});

describe('orderVenuesByStaleness (legacy utility retained)', () => {
  it('still orders most-starved-first for the deep-backfill / historical callers', () => {
    const f = new Map([['B', 5], ['A', 5], ['C', 5]]);
    expect(orderVenuesByStaleness(['B', 'A', 'C'], f)).toEqual(['A', 'B', 'C']);
  });
});
