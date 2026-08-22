/**
 * OPS-DIRECTIONAL-LABEL-HALT-W1 — the generator-fix battery.
 *
 * Incident class: silent per-venue starvation (alphabetical full pass never
 * survived to the tail; 8 venues dead 16 days). These tests pin the structural
 * guarantees: stalest-first rotation, clean-exit budgets, per-venue isolation,
 * the nightly recency window, and orchestrator flag passthrough.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
import {
  detectCapacityShortfall,
  deriveRunOutcome,
  lookbackCutoff,
  makeBudget,
  orderVenuesBySloDeadline,
  orderVenuesByStaleness,
  parseCli,
  partitionByVenue,
  runVenueRotation,
  type VenueRunSummary,
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

/**
 * ── OPS-MONITORING-SIGNAL-CONTRACT-W1 CH3 — the incident becomes a test. ─────────────────────
 *
 * On 2026-08-22 this detector published `est_venue_min_short=26` as a structural capacity
 * verdict from a run SIGTERM'd at 46.6 of 210 minutes. These blocks pin BOTH directions: the
 * truncated run may never claim capacity, and a genuinely budget-expired run still must.
 */
describe('CH3 D1 — a run that did not finish cannot publish a capacity conclusion', () => {
  const NOW = 1_755_000_000;
  const frontier = new Map<string, number>();           // every venue never labeled -> in danger
  const order = ['EDGEX', 'BITMART', 'OKX', 'HL', 'BINANCE', 'BITGET', 'BYBIT'];
  /** The real 2026-08-22 rotation, verbatim: 4 venues reached, HL stopped at the SIGTERM. */
  const INCIDENT: VenueRunSummary[] = [
    { venue: 'EDGEX', groupsDone: 7, groupsTotal: 7, outcome: 'complete', elapsedS: 0 },
    { venue: 'BITMART', groupsDone: 63, groupsTotal: 110, outcome: 'venue-circuit-break', elapsedS: 522 },
    { venue: 'OKX', groupsDone: 438, groupsTotal: 438, outcome: 'complete', elapsedS: 455 },
    { venue: 'HL', groupsDone: 214, groupsTotal: 335, outcome: 'stopped', elapsedS: 1819 },
  ];

  it('AC3.1 — the 2026-08-22 fixture yields INDETERMINATE', () => {
    const cap = detectCapacityShortfall(INCIDENT, order, frontier, NOW, undefined, 24, false);
    expect(cap.runOutcome).toBe('stopped');
    expect(cap.verdict).toBe('INDETERMINATE');
  });

  it('reproduces est_venue_min_short=26 exactly — the number is still MEASURED, just not a claim', () => {
    // 3 unreached-in-danger x median([7.58, 8.70, 30.32]) = 3 x 8.70 = 26.1 -> 26.
    const cap = detectCapacityShortfall(INCIDENT, order, frontier, NOW, undefined, 24, false);
    expect(cap.unreachedInDanger).toEqual(['BINANCE', 'BITGET', 'BYBIT']);
    expect(cap.estVenueMinShort).toBe(26);
    expect(cap.shortfall).toBe(true);   // the shortfall is REAL; the capacity CONCLUSION is not
  });

  it('AC3.2 — a genuinely budget-expired run still yields FAIL', () => {
    const finished = INCIDENT.map((s) => (s.outcome === 'stopped' ? { ...s, outcome: 'global-budget' as const } : s));
    const cap = detectCapacityShortfall(finished, order, frontier, NOW, undefined, 24, true);
    expect(cap.runOutcome).toBe('global-budget');
    expect(cap.verdict).toBe('FAIL');
  });

  it('a complete run with nothing in danger yields PASS, not silence', () => {
    const fresh = new Map(order.map((v) => [v, NOW - 60]));
    const all: VenueRunSummary[] = order.map((v) => ({ venue: v, groupsDone: 1, groupsTotal: 1, outcome: 'complete', elapsedS: 60 }));
    const cap = detectCapacityShortfall(all, order, fresh, NOW, undefined, 24, false);
    expect(cap.verdict).toBe('PASS');
    expect(cap.shortfall).toBe(false);
  });

  it('deriveRunOutcome is worst-first — one stopped venue decapitates the whole run', () => {
    expect(deriveRunOutcome(INCIDENT, false)).toBe('stopped');
    expect(deriveRunOutcome(INCIDENT, true)).toBe('stopped');   // stopped dominates budget-expiry
    expect(deriveRunOutcome([INCIDENT[0], INCIDENT[2]], false)).toBe('complete');
    expect(deriveRunOutcome([INCIDENT[0], INCIDENT[2]], true)).toBe('global-budget');
    expect(deriveRunOutcome([INCIDENT[1]], false)).toBe('venue-circuit-break');
  });
});

/**
 * ── CH3 D2/D3/D4 — the CONSUMER half, driven end to end through the real Python function. ────
 *
 * A producer-side contract alone would have changed nothing about 2026-08-22: the page was
 * emitted by `forward_capacity_signal` re-reading a marker. So these assertions drive that exact
 * function over fixture logs and observe whether a page reaches the wrapper.
 *
 * SPAWN BUDGET DECLARED on every block here — each shells out to python3.
 */
describe('CH3 — the consumer refuses what it cannot stand behind', () => {
  const PYDIR = path.join(REPO_ROOT, 'ops/monitoring');

  /** Run forward_capacity_signal over a fixture log; report whether a page was sent, and its body. */
  function forward(envelope: Record<string, unknown> | null, opts: { runId?: string; stillBreaching?: string[] | null } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'ch3-'));
    const wrapper = path.join(dir, 'fake-wrapper.sh');
    const captured = path.join(dir, 'body.txt');
    writeFileSync(wrapper, `#!/bin/sh\ncat > ${captured}\n`, { mode: 0o755 });
    const runId = opts.runId ?? 'dwr-2026-08-22T02:33:26.000Z';
    const log = path.join(dir, 'carry-labeler.log');
    writeFileSync(log, [
      '[2026-08-22T02:33:26.139Z] previous noise',
      `[detector-run] run_id=${runId}`,
      '[2026-08-22T02:33:26.139Z] DWR backfill start — 13499 groups over 17 venues',
      ...(envelope ? [`[detector-envelope] ${JSON.stringify(envelope)}`] : []),
    ].join('\n'));
    const sb = opts.stillBreaching === undefined ? 'None'
      : opts.stillBreaching === null ? 'None' : JSON.stringify(opts.stillBreaching);
    const driver = [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location('dlf', ${JSON.stringify(path.join(PYDIR, 'directional-label-freshness.py'))})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      `sent = m.forward_capacity_signal(${JSON.stringify(wrapper)}, ${JSON.stringify(log)}, ${sb === 'None' ? 'None' : `set(${sb})`})`,
      'print(json.dumps({"sent": bool(sent)}))',
    ].join('\n');
    const r = spawnSync('python3', ['-c', driver], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`driver failed: ${r.stderr}`);
    const sent = JSON.parse(r.stdout.trim().split('\n').pop() as string).sent as boolean;
    const body = existsSync(captured) ? readFileSync(captured, 'utf8') : '';
    return { sent, body };
  }

  const base = (over: Record<string, unknown> = {}) => ({
    schema_version: 1,
    detector: 'directional-label-capacity',
    verdict: 'INDETERMINATE',
    run_id: 'dwr-2026-08-22T02:33:26.000Z',
    run_started_at: '2026-08-22T02:33:26.000Z',
    run_outcome: 'stopped',
    produced_at: new Date().toISOString(),
    observation_window: { from: '2026-08-22T02:33:26.000Z', to: new Date().toISOString() },
    evidence: {
      unreached_in_danger: 'BINANCE,BITGET,BYBIT',
      unreached_count: 3,
      est_venue_min_short: 26,
      venues_reached: 4,
      venues_total: 17,
      elapsed_min: 46.6,
      budget_min: 210,
      budget_expired: false,
    },
    ...over,
  });

  it('AC3.1 — the 2026-08-22 envelope forwards as INDETERMINATE and makes NO capacity claim', { timeout: 30_000 }, () => {
    const { sent, body } = forward(base());
    expect(sent).toBe(true);                      // visible, never silence
    expect(body).toContain('INDETERMINATE');
    expect(body).toContain('outcome=stopped');
    expect(body).toContain('Action: none');       // no capacity wave is dispatched
    expect(body).not.toContain('OPS-LABEL-CAPACITY-W');
  });

  it('AC3.2 — a genuinely budget-expired run DOES page, and names the wave', { timeout: 30_000 }, () => {
    const { sent, body } = forward(base({ verdict: 'FAIL', run_outcome: 'global-budget' }));
    expect(sent).toBe(true);
    expect(body).toContain('OPS-LABEL-CAPACITY-W{NEXT}');
    expect(body).toContain('FAIL');
  });

  it('AC3.3 — the body is built from evidence: mutate a value and the body MUST change', { timeout: 30_000 }, () => {
    // STRUCTURAL, not a string search. A body that survives an evidence mutation is not built
    // from evidence, whatever its source looks like.
    const a = forward(base({ verdict: 'FAIL', run_outcome: 'global-budget' })).body;
    const mutated = base({ verdict: 'FAIL', run_outcome: 'global-budget' });
    (mutated.evidence as Record<string, unknown>).est_venue_min_short = 9999;
    const b = forward(mutated).body;
    expect(a).not.toBe(b);
    expect(a).toContain('est_venue_min_short=26');
    expect(b).toContain('est_venue_min_short=9999');
  });

  it('AC3.3 — zero hardcoded mechanism prose survives in the rendered body', { timeout: 30_000 }, () => {
    const { body } = forward(base({ verdict: 'FAIL', run_outcome: 'global-budget' }));
    expect(body).not.toContain('long-tail overflow');
    expect(body).not.toContain('majors were served first');
  });

  it('AC3.4 — a marker from an OLDER run is refused, and nothing is sent', { timeout: 30_000 }, () => {
    const { sent, body } = forward(base(), { runId: 'dwr-2026-08-23T02:33:26.000Z' });
    expect(sent).toBe(false);
    expect(body).toBe('');
  });

  it('AC3.4 — an over-age envelope is refused (the 3h33m case is IN-age by design)', { timeout: 30_000 }, () => {
    const old = base({ produced_at: '2026-08-01T00:00:00Z' });
    expect(forward(old).sent).toBe(false);
    // 3h33m is well inside max_age_seconds: the D3 page was NOT stale, it was REPAIRED. The
    // control for it is the re-census below, not the age bound.
    const threeAndAHalfHours = new Date(Date.now() - 3.55 * 3600 * 1000).toISOString();
    expect(forward(base({ produced_at: threeAndAHalfHours })).sent).toBe(true);
  });

  it('D3 — a venue repaired by THIS run is dropped; if all were, nothing pages', { timeout: 30_000 }, () => {
    // The measured 2026-08-22 timeline: BINANCE repaired 06:44:40Z, BITGET 06:52:30Z, page 06:53:19Z.
    const allHealed = forward(base({ verdict: 'FAIL', run_outcome: 'global-budget' }), { stillBreaching: [] });
    expect(allHealed.sent).toBe(false);
    const oneLeft = forward(base({ verdict: 'FAIL', run_outcome: 'global-budget' }), { stillBreaching: ['BYBIT'] });
    expect(oneLeft.sent).toBe(true);
    expect(oneLeft.body).toContain('unreached_in_danger=BYBIT');
    expect(oneLeft.body).toContain('dropped_after_recovery=BINANCE,BITGET');
  });

  it('a missing envelope pages nobody but is NOT silent in the log', { timeout: 30_000 }, () => {
    expect(forward(null).sent).toBe(false);
  });

  it('the TRANSITIONAL legacy marker is adapted, and can only ever be INDETERMINATE', { timeout: 30_000 }, () => {
    // The consumer installs by reviewed SSH; the producer ships in the container image. In the
    // window between, the host runs the new consumer against the old producer — without this
    // path that window is a dark guard, this wave's own defect reintroduced by its rollout.
    const dir = mkdtempSync(path.join(tmpdir(), 'ch3-legacy-'));
    const wrapper = path.join(dir, 'w.sh');
    const captured = path.join(dir, 'body.txt');
    writeFileSync(wrapper, `#!/bin/sh\ncat > ${captured}\n`, { mode: 0o755 });
    const log = path.join(dir, 'l.log');
    writeFileSync(log, [
      '[detector-run] run_id=dwr-2026-08-22T02:33:26.000Z',
      '[2026-08-22T02:33:26.139Z] DWR backfill start — 13499 groups over 17 venues',
      '[capacity-shortfall] unreached_in_danger=BINANCE,BITGET,BYBIT count=3 est_venue_min_short=26 '
        + 'budget_min=210 venues=17 recommended_wave=OPS-LABEL-CAPACITY-W{NEXT}',
    ].join('\n'));
    const driver = [
      'import importlib.util, json',
      `spec = importlib.util.spec_from_file_location('dlf', ${JSON.stringify(path.join(PYDIR, 'directional-label-freshness.py'))})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      `print(json.dumps({"sent": bool(m.forward_capacity_signal(${JSON.stringify(wrapper)}, ${JSON.stringify(log)}, None))}))`,
    ].join('\n');
    const r = spawnSync('python3', ['-c', driver], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').pop() as string).sent).toBe(true);
    const body = readFileSync(captured, 'utf8');
    expect(body).toContain('INDETERMINATE');
    expect(body).toContain('outcome=unknown');
    expect(body).toContain('est_venue_min_short=26');   // the measurement survives
    expect(body).toContain('Action: none');             // the CONCLUSION does not
    expect(body).not.toContain('OPS-LABEL-CAPACITY-W'); // and no capacity wave is dispatched
  });

  it('AC3.5 — exit 137 is classified as SIGKILL, distinct from flock-busy', { timeout: 30_000 }, () => {
    const driver = [
      'import importlib.util',
      `spec = importlib.util.spec_from_file_location('dlf', ${JSON.stringify(path.join(PYDIR, 'directional-label-freshness.py'))})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'print(m._classify_recovery_exit(137)); print(m._classify_recovery_exit(1)); print(m._classify_recovery_exit(143))',
    ].join('\n');
    const r = spawnSync('python3', ['-c', driver], { encoding: 'utf8' });
    const [sigkill, flock, sigterm] = r.stdout.trim().split('\n');
    expect(sigkill).toContain('SIGKILL');
    expect(sigkill).toContain('deploy recreate');
    expect(flock).toContain('flock busy');
    expect(sigterm).toContain('SIGTERM');
    expect(sigkill).not.toBe(flock);
  });
});
