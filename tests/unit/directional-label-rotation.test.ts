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
  lookbackCutoff,
  makeBudget,
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
