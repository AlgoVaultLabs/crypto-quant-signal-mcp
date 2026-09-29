import { describe, it, expect, vi, beforeEach } from 'vitest';

// EDGE-LABELER-RACE-WINDOW-V2-W1 CH2b (ruling LRW-Q11 = A) — the hold -v2 family, write-only, beside an
// UNCHANGED hold -v1. Drives the REAL `main()` of backfill-hold-decision-labels.ts with the DB and the venue
// replaced at their seams (R0.2's reproduction, as a pinned test). Synthetic prices only.
//
//  * hold -v1 keeps its own cache — the retired off-grid extension included — until the HOLD-discipline owner
//    rules (§11.6): the defective label it wrote before this wave, it still writes.
//  * hold -v2 races the corrected window by time for the decisions whose -v1 row the run wrote, the coarser-served
//    decisions whose -v1 cut timeout is unwritable, and a bounded RETRY list (rulings LRW-Q15 = A, LRW-Q16 = A).
//  * hold -v2 runs on the REMAINDER of the budget: out of time, it writes nothing and says how much it skipped —
//    and it never changes the -v1 run's verdict or exit code.

const TF = 300_000; // 5m, W = 12
const G = 5_966_000 * TF; // an on-grid anchor (2026-09-12T08:00Z)
const d1 = Math.floor(G / 1000) + 13; // off-grid decision #1 (G + 13 s)
const d2 = Math.floor(G / 1000) + 25 * 60 + 50; // decision #2 (G + 25 m 50 s), same cell
const HOLE = G + 75 * 60_000; // the candle the retired extension never fetches — the only target touch
const OVER = G + 90 * 60_000; // the first candle past d2's vertical barrier — the only adverse touch
const candle = (t: number) => ({ time: t, open: 100, close: 100, high: t === HOLE ? 101 : 100.1, low: t === OVER ? 99 : 99.9, volume: 1 });

type Row = { decision_id: number; decided_at: number; coin: string; timeframe: string; exchange: string; would_be_side: number; price_at_decision: number };
const BASE: Row[] = [
  { decision_id: 1, decided_at: d1, coin: 'BTC', timeframe: '5m', exchange: 'BINANCE', would_be_side: 1, price_at_decision: 100 },
  { decision_id: 2, decided_at: d2, coin: 'BTC', timeframe: '5m', exchange: 'BINANCE', would_be_side: 1, price_at_decision: 100 },
];

// A small in-memory hold store: the -v1 work-list honours its NOT EXISTS bind, the -v2 retry list its
// EXISTS / NOT EXISTS / decided_at binds, and labels persist across the nights of one test.
const env = vi.hoisted(() => ({
  decisions: [] as Array<Record<string, unknown>>,
  labels: new Map<string, unknown[]>(), // `${decision}|${spec}` → the row
  inserted: [] as unknown[][], // this run's inserts
  calls: [] as Array<[number, number | undefined, number]>, // [start, end, rows inserted before the call]
  onFetch: null as null | ((start: number, end: number | undefined) => void),
  step: 300_000, // the venue's candle grid
  pageCap: 1000,
  serveUntil: Infinity, // candles that have OPENED by "now"
  candleAt: null as null | ((t: number) => Record<string, number>),
  holes: new Set<string>(), // `${coin}|${open}` the venue never serves
  logs: [] as string[],
  failRetrySql: false, // the -v2 retry read throws (a DB fault in the -v2 pass)
  emptyForwardAtEnd: null as null | { end: number; entry: number; v1Only?: boolean }, // a call with this `end` serves nothing ≥ entry
  v2Started: false, // the -v2 pass has begun (its retry read ran): later fetches are -v2's
  verdictBeforeV2Fetch: null as null | boolean, // at the first -v2 fetch: had the -v1 verdict line been printed?
}));
vi.mock('../../src/lib/performance-db.js', () => ({
  dbQuery: async (sql: string, params: unknown[] = []) => {
    if (/INSERT INTO hold_decision_labels/.test(sql)) {
      const out: Array<{ hold_decision_id: unknown }> = [];
      for (let i = 0; i < params.length; i += 9) {
        const r = params.slice(i, i + 9);
        const k = `${r[0]}|${r[1]}`;
        if (env.labels.has(k)) continue; // ON CONFLICT DO NOTHING
        env.labels.set(k, r);
        env.inserted.push(r);
        out.push({ hold_decision_id: r[0] });
      }
      return out;
    }
    const has = (id: unknown, spec: unknown) => env.labels.has(`${id}|${spec}`);
    if (/FROM eligible/.test(sql)) return env.decisions.filter((d) => !has(d.decision_id, params[0]));
    if (/FROM hold_decisions h\s+JOIN unnest/.test(sql)) {
      env.v2Started = true;
      if (env.failRetrySql) throw new Error('connection terminated unexpectedly');
      // the retry list: honours EXISTS / NOT EXISTS / the pre-filter / the exclusion, and the per-pair bound only
      // if the SQL says it; the count form adds the last-chance bound; the ORDER BY is honoured as written
      const perRow = /h\.decided_at > b\.lo_s/.test(sql);
      const isCount = /SELECT count\(\*\) AS n/.test(sql);
      const [ex, tf, lo, excl] = [params[3] as string[], params[4] as string[], params[5] as number[], params[6] as number[]];
      const loNext = isCount ? (params[params.length - 1] as number[]) : null;
      const idx = (d: Record<string, unknown>) => ex.findIndex((e, k) => e === d.exchange && tf[k] === d.timeframe);
      const out = env.decisions.filter((d) => {
        if (!has(d.decision_id, params[0]) || has(d.decision_id, params[1]) || !(Number(d.decided_at) > Number(params[2]))) return false;
        if (/decision_id <> ALL\(\$7/.test(sql) && excl.map(Number).includes(Number(d.decision_id))) return false;
        const i = idx(d);
        if (i < 0 || (perRow && !(Number(d.decided_at) > lo[i]))) return false;
        return !loNext || Number(d.decided_at) <= loNext[i];
      });
      if (isCount) return [{ n: String(out.length) }]; // pg returns count(*) as a string
      const urgency = /ORDER BY h\.decided_at - b\.lo_s/.test(sql);
      out.sort((a, b) => (urgency ? (Number(a.decided_at) - lo[idx(a)]) - (Number(b.decided_at) - lo[idx(b)]) : 0)
        || String(a.exchange).localeCompare(String(b.exchange)) || String(a.coin).localeCompare(String(b.coin))
        || Number(a.decided_at) - Number(b.decided_at));
      return out.slice(0, Number(params[params.length - 1])); // the LIMIT
    }
    if (/SELECT hold_decision_id, barrier_spec FROM hold_decision_labels/.test(sql)) {
      const [ids, specs] = params as [number[], string[]];
      return [...env.labels.values()]
        .filter((r) => ids.includes(Number(r[0])) && specs.includes(String(r[1])))
        .map((r) => ({ hold_decision_id: r[0], barrier_spec: r[1] }));
    }
    return [];
  },
  closeDb: () => undefined,
  closeDbAsync: async () => undefined,
}));
vi.mock('../../src/lib/exchange-adapter.js', () => ({
  getAdapter: () => ({
    getCandles: async (coin: string, _tf: string, start: number, _dex: unknown, end?: number) => {
      env.calls.push([start, end, env.inserted.length]);
      if (env.v2Started && env.verdictBeforeV2Fetch === null) {
        env.verdictBeforeV2Fetch = env.logs.some((l) => l.startsWith('HOLD_LABEL_VERDICT='));
      }
      env.onFetch?.(start, end);
      const out = [];
      const last = Math.min(end ?? start + env.pageCap * env.step, env.serveUntil);
      for (let t = Math.ceil(start / env.step) * env.step; t <= last && out.length < env.pageCap; t += env.step) {
        if (env.holes.has(`${coin}|${t}`)) continue;
        const ef = env.emptyForwardAtEnd;
        if (ef && end === ef.end && t >= ef.entry && !(ef.v1Only && env.v2Started)) continue;
        out.push((env.candleAt ?? candle)(t));
      }
      return out;
    },
  }),
}));

import {
  main, holdV2Retryable, holdV2RetryBounds, holdV2RetryAccounting,
  HOLD_V2_RETRY_GRACE_MS, HOLD_V2_RETRY_PREFILTER_S, HOLD_NIGHTLY_CADENCE_MS,
} from '../../src/scripts/backfill-hold-decision-labels.js';
import { runTripleBarrier, EVAL_CANDLES, BARRIER_SPECS_V2, computeSigmaW, barrierPct } from '../../src/scripts/directional-labeler.js';
import { servedCandleStepMs, SERVED_VENUES } from '../../src/lib/tf-support.js';

const NOW = G + 86_400_000;
async function run(args: string[], nowMs = NOW): Promise<{ rc: number; verdict: string; evidence: Record<string, unknown> }> {
  env.inserted.length = 0;
  env.calls.length = 0;
  env.v2Started = false;
  env.verdictBeforeV2Fetch = null;
  const logs: string[] = [];
  env.logs = logs;
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(nowMs));
  try {
    const rc = await main(args);
    const line = logs.find((l) => l.startsWith('HOLD_LABEL_VERDICT='))!;
    const v2Line = logs.find((l) => l.startsWith('HOLD_V2_EVIDENCE '));
    return {
      rc,
      verdict: line.slice('HOLD_LABEL_VERDICT='.length, line.indexOf(' ')),
      // the -v1 verdict's evidence, then the -v2 pass's own record line
      evidence: { ...JSON.parse(line.slice(line.indexOf('{'))), ...(v2Line ? JSON.parse(v2Line.slice(v2Line.indexOf('{'))) : {}) },
    };
  } finally {
    vi.useRealTimers();
    spy.mockRestore();
  }
}
const rowsOf = (id: number, suffix: string) => env.inserted.filter((r) => r[0] === id && String(r[1]).endsWith(suffix));

beforeEach(() => {
  env.onFetch = null;
  env.decisions = BASE.map((d) => ({ ...d }));
  env.labels.clear();
  env.step = TF;
  env.pageCap = 1000;
  env.serveUntil = Infinity;
  env.candleAt = null;
  env.holes = new Set();
  env.failRetrySql = false;
  env.emptyForwardAtEnd = null;
});
const tokenLine = (name: string) => env.logs.find((l) => l.startsWith(`${name} `));

describe('hold -v2 beside an unchanged hold -v1 (real main)', () => {
  it('hold -v1 still writes what it wrote before this wave; hold -v2 writes the gap-free race', { timeout: 60_000 }, async () => {
    const { evidence } = await run(['--per-cell', '3', '--max-decisions', '10']);
    // the gap-free reference: the TRUE window of d2 (every 5m candle from its first open)
    const t0 = Math.ceil((d2 * 1000) / TF) * TF;
    const trueWindow = Array.from({ length: 12 }, (_, i) => candle(t0 + i * TF));
    const ref = runTripleBarrier('BUY', 100, trueWindow, 0.3, 12);
    expect(ref.label).toBe(1);
    expect(ref.tHitCandles).toBe(10);
    // hold -v1: UNCHANGED — its cache still drops HOLE and its race still runs past the barrier (owner's call)
    const v1 = rowsOf(2, '-v1');
    expect(v1).toHaveLength(3);
    for (const r of v1) {
      expect(r[2]).toBe(-1);
      expect(r[5]).toBe(12);
    }
    // hold -v2: the corrected race, one row per τ, never low-vol
    const v2 = rowsOf(2, '-v2');
    expect(v2).toHaveLength(3);
    for (const r of v2) {
      expect(r[2]).toBe(ref.label);
      expect(r[5]).toBe(ref.tHitCandles);
      expect(r[4]).toBe(false);
    }
    expect(rowsOf(1, '-v2')).toHaveLength(3);
    expect(evidence).toMatchObject({ v2_labeled: 6, v2_written: 6, v2_refused: 0, v2_deferred: 0, v2_groups_not_reached: 0 });
    // the -v1 token is printed BEFORE the -v2 pass fetches anything, with no -v2 key in it
    expect(env.verdictBeforeV2Fetch).toBe(true);
    const verdictLine = env.logs.find((l) => l.startsWith('HOLD_LABEL_VERDICT='))!;
    expect(Object.keys(JSON.parse(verdictLine.slice(verdictLine.indexOf('{')))).filter((k) => k.startsWith('v2_'))).toEqual([]);
  });

  it('hold -v2 takes only the remainder of the budget: out of time, it writes nothing and counts what it skipped', { timeout: 60_000 }, async () => {
    // every venue fetch costs the run two minutes of its one-minute budget
    env.onFetch = () => vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
    const { rc, verdict, evidence } = await run(['--per-cell', '3', '--max-decisions', '10', '--time-budget-min', '1']);
    expect(rowsOf(1, '-v1').length + rowsOf(2, '-v1').length).toBeGreaterThan(0); // -v1 is never displaced
    expect(env.inserted.filter((r) => String(r[1]).endsWith('-v2'))).toHaveLength(0);
    expect(evidence).toMatchObject({ v2_written: 0, v2_groups_not_reached: 1 });
    expect([verdict, rc]).toEqual(['INDETERMINATE', 3]); // -v1 itself ran past its budget
  });

  it('a -v2 pass that overruns the budget never turns a complete -v1 run INDETERMINATE: the verdict is the -v1 run\'s', { timeout: 60_000 }, async () => {
    env.onFetch = () => vi.setSystemTime(new Date(Date.now() + 25_000)); // -v1: 2 fetches = 50 s; -v2 runs on past 60 s
    const { rc, verdict, evidence } = await run(['--per-cell', '3', '--max-decisions', '10', '--time-budget-min', '1']);
    expect(rowsOf(1, '-v1')).toHaveLength(3);
    expect(rowsOf(2, '-v1')).toHaveLength(3);
    expect(Number(evidence.elapsed_min)).toBeLessThan(1); // -v1 finished inside its budget…
    expect(Number(evidence.v2_elapsed_min_total)).toBeGreaterThan(1); // …and the run as a whole DID pass it
    expect(evidence).toMatchObject({ v2_written: 6, v2_groups_not_reached: 0 });
    expect([verdict, rc]).toEqual(['PASS', 0]); // …in the -v2 remainder, which is record-only
  });

  it('the hold -v2 fetch pages on the served step from the next grid boundary — never from an off-grid range end', { timeout: 60_000 }, async () => {
    await run(['--per-cell', '3', '--max-decisions', '10']);
    // the -v2 pass starts after the -v1 rows are inserted: every call made after that insert is -v2's
    const v1Calls = env.calls.filter(([, , n]) => n === 0);
    const v2Calls = env.calls.filter(([, , n]) => n > 0);
    expect(v1Calls.length).toBeGreaterThan(1);
    expect(v2Calls.length).toBeGreaterThan(1);
    // -v1 (unchanged): its extension still starts off the grid, past HOLE
    expect(v1Calls[1][0] % TF).not.toBe(0);
    expect(v1Calls.some(([s, e]) => s <= HOLE && HOLE <= (e as number))).toBe(false);
    // -v2: extensions start ON the grid and HOLE is requested
    for (const [start] of v2Calls.slice(1)) expect(start % TF).toBe(0);
    expect(v2Calls.some(([s, e]) => s <= HOLE && HOLE <= (e as number))).toBe(true);
  });
});

// ── coarser / finer served pairs, scope, and the bounded retry (review 2026-09-29) ─────────────────────────
const M = 60_000;
const H = 60 * M;
const DAY = 24 * H;
const gate = (id: number, tf: string, decidedAtMs: number): Row =>
  ({ decision_id: id, decided_at: Math.floor(decidedAtMs / 1000), coin: 'ETH', timeframe: tf, exchange: 'GATE', would_be_side: 1, price_at_decision: 100 });
const flatC = (t: number) => ({ time: t, open: 100, close: 100, high: 100.05, low: 99.95, volume: 1 });

describe('hold -v2 on the SERVED grid, its scope, and its retry (real main)', () => {
  it('coarser-served (GATE 3m served as 5m): the hold -v2 race runs on the 5m grid — one row per τ, nothing refused', { timeout: 60_000 }, async () => {
    const served = servedCandleStepMs('GATE', '3m')!;
    expect(served).toBe(5 * M);
    env.step = served;
    const e = G + 2 * M + 17_000;
    const touch = Math.ceil(e / served) * served + served; // the 2nd served candle
    env.candleAt = (t) => (t === touch ? { ...flatC(t), high: 101 } : flatC(t));
    env.decisions = [gate(11, '3m', e)];
    const { evidence } = await run(['--per-cell', '3', '--max-decisions', '10']);
    expect(rowsOf(11, '-v1')).toHaveLength(3);
    const v2 = rowsOf(11, '-v2');
    expect(v2).toHaveLength(3);
    for (const r of v2) { expect(r[2]).toBe(1); expect(r[5]).toBe(2); }
    expect(evidence).toMatchObject({ v2_refused: 0, v2_unreachable_history: 0 });
  });

  it('finer-served (GATE 2h served as 1h, 200-candle pages): every -v2 page starts one SERVED step past the last', { timeout: 60_000 }, async () => {
    const served = servedCandleStepMs('GATE', '2h')!;
    expect(served).toBe(H);
    env.step = served;
    env.pageCap = 200; // gateio.ts
    const e = G + 17 * M + 17_000;
    env.decisions = [gate(12, '2h', e)];
    const { evidence } = await run(['--per-cell', '3', '--max-decisions', '10']);
    expect(rowsOf(12, '-v2')).toHaveLength(3);
    expect(evidence).toMatchObject({ v2_refused: 0, v2_unreachable_history: 0 });
    const v2Calls = env.calls.filter(([, , n]) => n > 0);
    expect(v2Calls.length).toBeGreaterThan(1);
    for (let i = 1; i < v2Calls.length; i++) {
      if (v2Calls[i][1] !== v2Calls[i - 1][1]) continue; // a new range, not the next page
      // the previous page's last candle (the mock's page: the grid from ceil(start), capped, ≤ end)
      const prevLast = Math.min(Math.ceil(v2Calls[i - 1][0] / H) * H + (env.pageCap - 1) * H, Math.floor((v2Calls[i - 1][1] as number) / H) * H);
      expect(v2Calls[i][0]).toBe(prevLast + H);
    }
  });

  it('scope: a decision whose -v1 row the run did NOT write (a failed fetch) gets no -v2 row either', { timeout: 60_000 }, async () => {
    const needEndD2 = d2 * 1000 + 14 * TF; // decision #2's -v1 range end (W+2 requested candles)
    let thrown = false;
    env.onFetch = (_s, end) => {
      if (!thrown && env.inserted.length === 0 && end === needEndD2) { thrown = true; throw new Error('venue 503'); }
    };
    const { evidence } = await run(['--per-cell', '3', '--max-decisions', '10']);
    expect(thrown).toBe(true);
    expect(rowsOf(1, '-v1')).toHaveLength(3);
    expect(rowsOf(1, '-v2')).toHaveLength(3);
    expect(rowsOf(2, '-v1')).toHaveLength(0);
    expect(rowsOf(2, '-v2')).toHaveLength(0);
    expect(evidence).toMatchObject({ v2_labeled: 3, errors: 1 });
  });

  it('coarser-served: a flat decision whose -v1 timeout the cut makes unwritable still gets its -v2 row (a timeout)', { timeout: 60_000 }, async () => {
    env.step = servedCandleStepMs('GATE', '3m')!;
    env.candleAt = flatC;
    env.decisions = [gate(13, '3m', G + 2 * M + 17_000)];
    const { evidence } = await run(['--per-cell', '3', '--max-decisions', '10']);
    expect(rowsOf(13, '-v1')).toHaveLength(0); // hold -v1 unchanged: < W served candles in its cut
    const v2 = rowsOf(13, '-v2');
    expect(v2).toHaveLength(3);
    for (const r of v2) expect(r[2]).toBe(0);
    expect(evidence).toMatchObject({ v2_cut_candidates: 1, v2_no_v1_twin: 3 });
    expect(tokenLine('V2_NO_V1_TWIN')).toBe('V2_NO_V1_TWIN written=3'); // a named, counted class
    // the next nightly re-attempts -v1 (still unwritable) and writes -v2 NOT again
    const again = await run(['--per-cell', '3', '--max-decisions', '10']);
    expect(rowsOf(13, '-v2')).toHaveLength(0);
    expect(again.evidence).toMatchObject({ v2_cut_candidates: 0, v2_no_v1_twin: 0 });
  });

  it('two nights: a 1d decision -v1 labels before its -v2 window closes is retried — and only within its bound', { timeout: 60_000 }, async () => {
    env.step = DAY;
    env.candleAt = flatC;
    const night1 = Math.floor(G / DAY) * DAY + 10 * DAY + 3 * H + 41 * M; // a 03:41Z nightly
    const decided = night1 - 3.5 * DAY; // -v1 due at +3 d, the -v2 window closes at +4 d
    // -v1 row present, -v2 absent: INSIDE the SQL pre-filter (8 d) but past its own per-row bound (4 d + 2 d)
    const stale = night1 - 6.5 * DAY;
    env.decisions = [
      { decision_id: 21, decided_at: decided / 1000, coin: 'SOL', timeframe: '1d', exchange: 'BINANCE', would_be_side: -1, price_at_decision: 100 },
      { decision_id: 22, decided_at: stale / 1000, coin: 'SOL', timeframe: '1d', exchange: 'BINANCE', would_be_side: -1, price_at_decision: 100 },
    ];
    for (const sp of ['tau0.5-floor0.30-v1', 'tau1.0-floor0.30-v1', 'tau2.0-floor0.30-v1']) env.labels.set(`22|${sp}`, [22, sp]);
    env.serveUntil = night1;
    const n1 = await run(['--per-cell', '3', '--max-decisions', '10'], night1);
    expect(rowsOf(21, '-v1')).toHaveLength(3);
    expect(rowsOf(21, '-v2')).toHaveLength(0);
    expect(rowsOf(22, '-v2')).toHaveLength(0);
    // decision 21 is this run's -v1 write, deferred: a candidate still retryable tomorrow → pending, counted
    expect(n1.evidence).toMatchObject({ v2_deferred: 1, v2_retry_candidates: 0, v2_retry_pending: 1, v2_retry_aged_out: 0 });
    expect(stale / 1000).toBeGreaterThan(night1 / 1000 - HOLD_V2_RETRY_PREFILTER_S); // the SQL does return it
    env.serveUntil = night1 + DAY;
    const n2 = await run(['--per-cell', '3', '--max-decisions', '10'], night1 + DAY);
    expect(rowsOf(21, '-v2')).toHaveLength(3); // raced the night its window had closed
    expect(rowsOf(21, '-v1')).toHaveLength(0); // -v1 is never rewritten
    expect(rowsOf(22, '-v2')).toHaveLength(0); // outside the bound: never the historical hold relabel
    expect(n2.evidence).toMatchObject({ v2_retry_candidates: 1, v2_retry_written: 1, v2_retry_aged_out: 0 });
    expect(tokenLine('HOLD_V2_RETRY')).toBe('HOLD_V2_RETRY pending=0 written=1 aged_out=0 terminal=0 limited=0');
  });

  it('retry rows are never silent: a last-night row the budget never reaches is AGED OUT; a refused one is TERMINAL', { timeout: 60_000 }, async () => {
    env.step = DAY;
    env.candleAt = flatC;
    const now = Math.floor(G / DAY) * DAY + 10 * DAY + 3 * H + 41 * M;
    // bound = decided + (3+1)·1d + 2 nightlies = decided + 6 d → the last retryable nightly is at age (5 d, 6 d]
    const lastNight = now - 5.5 * DAY;
    const earlier = now - 4.5 * DAY; // retryable again tomorrow
    const mk = (id: number, at: number, coin = 'ADA') =>
      ({ decision_id: id, decided_at: at / 1000, coin, timeframe: '1d', exchange: 'BINANCE', would_be_side: 1, price_at_decision: 100 });
    env.decisions = [mk(31, lastNight), mk(32, earlier, 'DOT'), mk(33, now - 3.5 * DAY)]; // 33: a fresh -v1 decision
    for (const id of [31, 32]) for (const sp of ['tau0.5-floor0.30-v1', 'tau1.0-floor0.30-v1', 'tau2.0-floor0.30-v1']) env.labels.set(`${id}|${sp}`, [id, sp]);
    env.serveUntil = now;
    // (1) the budget is gone before -v2 starts: 31 ages out, 32 stays pending
    env.onFetch = () => vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
    const cut = await run(['--per-cell', '3', '--max-decisions', '10', '--time-budget-min', '1'], now);
    // candidates: 33 (this run's -v1 write), 31 and 32 (retry) — 31 is on its last night: aged out, never silent
    expect(cut.evidence).toMatchObject({ v2_retry_candidates: 2, v2_candidates: 3, v2_retry_aged_out: 1, v2_retry_pending: 2, v2_retry_written: 0 });
    expect(tokenLine('HOLD_V2_RETRY')).toBe('HOLD_V2_RETRY pending=2 written=0 aged_out=1 terminal=0 limited=0');
    // (2) with budget, a hole inside 31's -v2 window: refused on its last night = TERMINAL, not aged out
    env.onFetch = null;
    env.labels.clear();
    for (const id of [31, 32]) for (const sp of ['tau0.5-floor0.30-v1', 'tau1.0-floor0.30-v1', 'tau2.0-floor0.30-v1']) env.labels.set(`${id}|${sp}`, [id, sp]);
    env.holes = new Set([`ADA|${Math.ceil(lastNight / DAY) * DAY + DAY}`]); // inside 31's -v2 window only
    const hole = await run(['--per-cell', '3', '--max-decisions', '10'], now);
    expect(rowsOf(31, '-v2')).toHaveLength(0);
    expect(rowsOf(32, '-v2')).toHaveLength(3);
    expect(hole.evidence).toMatchObject({ v2_retry_terminal: 1, v2_retry_aged_out: 0, v2_retry_written: 1 });
  });

  it('the retry accounting is a pure function of the outcomes and the bound', () => {
    const now = 2_000_000_000_000;
    const at = (daysAgo: number) => Math.floor((now - daysAgo * DAY) / 1000);
    const rows = [
      { decision_id: 1, decided_at: at(5.5), timeframe: '1d', exchange: 'BINANCE' },
      { decision_id: 2, decided_at: at(4.5), timeframe: '1d', exchange: 'BINANCE' },
      { decision_id: 3, decided_at: at(5.5), timeframe: '1d', exchange: 'BINANCE' },
      { decision_id: 4, decided_at: at(5.5), timeframe: '1d', exchange: 'BINANCE' },
    ];
    const out = new Map([[1, 'notReached'], [2, 'refused'], [3, 'written'], [4, 'unreachable']] as const);
    expect(holdV2RetryAccounting(rows, out, now)).toEqual({ pending: 1, written: 1, agedOut: 1, terminal: 1 });
    // errored or still deferred on the last night: aged out too — only an answered refusal is terminal
    const last = [{ decision_id: 5, decided_at: at(5.5), timeframe: '1d', exchange: 'BINANCE' }, { decision_id: 6, decided_at: at(5.5), timeframe: '1d', exchange: 'BINANCE' }];
    expect(holdV2RetryAccounting(last, new Map([[5, 'error'], [6, 'deferred']] as const), now)).toEqual({ pending: 0, written: 0, agedOut: 2, terminal: 0 });
    // the schedule jitter: a bound 27 h ahead is still a LAST chance (the next nightly may start up to 6 h late)
    const edge = [{ decision_id: 7, decided_at: Math.floor((now + 27 * H - 4 * DAY - HOLD_V2_RETRY_GRACE_MS) / 1000), timeframe: '1d', exchange: 'BINANCE' }];
    expect(holdV2Retryable(edge[0], now + 26 * H)).toBe(true);
    expect(holdV2RetryAccounting(edge, new Map([[7, 'notReached']] as const), now)).toEqual({ pending: 0, written: 0, agedOut: 1, terminal: 0 });
    // a scoped (per-venue) leg never calls a row lost — the unscoped leg after it can still write it
    expect(holdV2RetryAccounting(rows, out, now, false)).toEqual({ pending: 3, written: 1, agedOut: 0, terminal: 0 });
    expect(HOLD_NIGHTLY_CADENCE_MS).toBe(DAY);
  });

  it('the retry bound: per row two nightlies past its own -v2 window; the SQL pre-filter never cuts a row it keeps', () => {
    let widest = 0;
    expect(SERVED_VENUES.length).toBeGreaterThanOrEqual(17);
    for (const v of SERVED_VENUES) for (const [tf, W] of Object.entries(EVAL_CANDLES)) {
      const step = servedCandleStepMs(v, tf);
      if (step == null) continue;
      widest = Math.max(widest, (W + 1) * step + HOLD_V2_RETRY_GRACE_MS);
    }
    // today: 6 d for 1d (W=3) · 7 d for PHEMEX 12h served on 1d (W=4) — the widest — plus the 6 h schedule jitter
    expect(widest).toBe(7 * DAY + 6 * H);
    expect(HOLD_V2_RETRY_PREFILTER_S * 1000).toBeGreaterThanOrEqual(widest);
    // the SQL bound IS holdV2Retryable: every pair, both sides of its edge
    const now = 2_000_000_000_123;
    const b = holdV2RetryBounds(now);
    expect(b.exchanges.length).toBeGreaterThan(100);
    b.exchanges.forEach((ex, i) => {
      for (const decided of [b.loS[i], b.loS[i] + 1]) {
        expect(holdV2Retryable({ decided_at: decided, timeframe: b.timeframes[i], exchange: ex }, now)).toBe(decided > b.loS[i]);
      }
    });
    const d = { decided_at: 1_000_000, timeframe: '1d', exchange: 'BINANCE' };
    const edge = d.decided_at * 1000 + (EVAL_CANDLES['1d'] + 1) * DAY + HOLD_V2_RETRY_GRACE_MS;
    expect(holdV2Retryable(d, edge - 1)).toBe(true);
    expect(holdV2Retryable(d, edge)).toBe(false);
    expect(BARRIER_SPECS_V2.map((x) => x.spec)).toContain('tau1.0-floor0.30-v2');
  });

  const mkRow = (id: number, at: number, extra: Partial<Row> = {}): Row =>
    ({ decision_id: id, decided_at: Math.floor(at / 1000), coin: 'LINK', timeframe: '1d', exchange: 'BINANCE', would_be_side: 1, price_at_decision: 100, ...extra });
  const seedV1 = (id: number, specs = ['tau0.5-floor0.30-v1', 'tau1.0-floor0.30-v1', 'tau2.0-floor0.30-v1']) => { for (const sp of specs) env.labels.set(`${id}|${sp}`, [id, sp]); };

  /** GATE 3m (served 5m) decision at `e` whose τ0.5 barrier is hit on the 1st served candle and τ1.0 / τ2.0
   *  time out inside the -v1 cut (unwritable). Returns the decision price. */
  const mixedTau = (id: number, e: number): number => {
    const served = servedCandleStepMs('GATE', '3m')!;
    env.step = served;
    env.pageCap = 1000;
    const open0 = Math.ceil(e / served) * served;
    let sd = 53 >>> 0;
    const rnd = () => ((sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const px = new Map<number, number>();
    let p = 100;
    for (let t = open0 - 400 * served; t < open0; t += served) { p *= 1 + (rnd() - 0.5) * 0.005; px.set(t, p); }
    const last = p;
    const lo = e - (60 * 12 + 2) * 180_000;
    const sigma = computeSigmaW([...px.entries()].filter(([t]) => t >= lo && t < e).map(([, c]) => c), 12).sigma;
    const [b05, b10] = [barrierPct(sigma, 0.5), barrierPct(sigma, 1.0)];
    expect(b10).toBeGreaterThan(b05);
    const touch = last * (1 + (b05 + b10) / 2 / 100);
    env.candleAt = (t) => {
      const c = px.get(t);
      if (c !== undefined) return { time: t, open: c, close: c, high: c * 1.0002, low: c * 0.9998, volume: 1 };
      return { time: t, open: last, close: last, high: t === open0 ? touch : last, low: last, volume: 1 };
    };
    env.decisions = [{ ...gate(id, '3m', e), price_at_decision: last }];
    return last;
  };

  it('per τ, and never re-raced: τ0.5 decided, τ1.0 / τ2.0 cut → 2 twin-less rows; the refused re-push the next night races nothing', { timeout: 60_000 }, async () => {
    mixedTau(14, G + 2 * M + 17_000);
    const n1 = await run(['--per-cell', '3', '--max-decisions', '10']);
    expect(rowsOf(14, '-v1').map((r) => r[1])).toEqual(['tau0.5-floor0.30-v1']);
    expect(rowsOf(14, '-v2')).toHaveLength(3);
    expect(n1.evidence).toMatchObject({ v2_no_v1_twin: 2 });
    // night 2: τ1.0 -v1 still missing → the -v1 work-list re-pushes τ0.5 (refused by the table): no -v2 work at all
    const n2 = await run(['--per-cell', '3', '--max-decisions', '10'], NOW + DAY);
    expect(env.inserted).toHaveLength(0);
    expect(n2.evidence).toMatchObject({ v2_candidates: 0, v2_labeled: 0, v2_no_v1_twin: 0 });
  });

  it('an EMPTY hold -v1 forward is no-klines, not a cut timeout: no -v2 row', { timeout: 60_000 }, async () => {
    env.step = servedCandleStepMs('GATE', '3m')!;
    env.candleAt = flatC;
    const e = G + 2 * M + 17_000;
    env.decisions = [gate(15, '3m', e)];
    env.emptyForwardAtEnd = { end: e + 14 * 180_000, entry: e }; // the hold -v1 range end (W+2 requested candles)
    const { evidence } = await run(['--per-cell', '3', '--max-decisions', '10']);
    expect(rowsOf(15, '-v1')).toHaveLength(0);
    expect(rowsOf(15, '-v2')).toHaveLength(0);
    expect(evidence).toMatchObject({ v2_cut_candidates: 0 });
  });

  it('a fault in the -v2 pass is RECORDED: the -v1 verdict token and exit code stand, and no count reads as zero', { timeout: 60_000 }, async () => {
    env.failRetrySql = true;
    const { rc, verdict, evidence } = await run(['--per-cell', '3', '--max-decisions', '10']);
    expect(rowsOf(1, '-v1')).toHaveLength(3);
    expect([verdict, rc]).toEqual(['PASS', 0]);
    expect(evidence.v2_error).toMatch(/connection terminated/);
    expect(evidence.v2_retry_aged_out).toBeNull();
    expect(tokenLine('HOLD_V2_RETRY')).toBe('HOLD_V2_RETRY error=1');
    expect(tokenLine('V2_NO_V1_TWIN')).toBe('V2_NO_V1_TWIN error=1');
  });

  it('the retry list says when it hit its cap (limited=1), and this run\'s own -v1 writes never spend it', { timeout: 60_000 }, async () => {
    env.step = DAY;
    env.candleAt = flatC;
    const now = Math.floor(G / DAY) * DAY + 10 * DAY + 3 * H + 41 * M;
    env.decisions = [mkRow(41, now - 4.5 * DAY), mkRow(42, now - 4.4 * DAY, { coin: 'UNI' })];
    seedV1(41); seedV1(42);
    env.serveUntil = now;
    const capped = await run(['--per-cell', '3', '--max-decisions', '1'], now);
    expect(capped.evidence).toMatchObject({ v2_retry_candidates: 1, v2_retry_limited: 1 });
    expect(tokenLine('HOLD_V2_RETRY')).toMatch(/ limited=1$/);
    const roomy = await run(['--per-cell', '3', '--max-decisions', '10'], now);
    expect(roomy.evidence).toMatchObject({ v2_retry_limited: 0 });
  });

  it('an OLD decision whose τ0.5 -v1 re-push the table refuses is not "this run\'s -v1 write": past its bound, no -v2', { timeout: 60_000 }, async () => {
    const e = G - 30 * DAY + 2 * M + 17_000;
    mixedTau(16, e);
    seedV1(16, ['tau0.5-floor0.30-v1']); // written long ago; τ1.0 / τ2.0 were never writable
    const { evidence } = await run(['--per-cell', '3', '--max-decisions', '10']);
    expect(env.inserted).toHaveLength(0); // the re-push was refused
    expect(rowsOf(16, '-v2')).toHaveLength(0); // the cut source is bounded; a refused re-push is no source at all
    expect(evidence).toMatchObject({ v2_candidates: 0 });
  });

  it('this run\'s own -v1 writes never spend the retry LIMIT', { timeout: 60_000 }, async () => {
    env.step = DAY;
    env.candleAt = flatC;
    const now = Math.floor(G / DAY) * DAY + 10 * DAY + 3 * H + 41 * M;
    env.decisions = [mkRow(51, now - 3.5 * DAY, { coin: 'AAA' }), mkRow(52, now - 4.5 * DAY, { coin: 'ZZZ' })];
    seedV1(52); // 52: a retry row; 51: -v1 written this run (its -v2 window still open)
    env.serveUntil = now;
    const { evidence } = await run(['--per-cell', '3', '--max-decisions', '1'], now);
    expect(rowsOf(51, '-v1')).toHaveLength(3);
    expect(rowsOf(52, '-v2')).toHaveLength(3);
    expect(evidence).toMatchObject({ v2_retry_candidates: 1, v2_retry_written: 1 });
  });

  it('int8 ids come back from pg as strings: this run\'s -v1 write is still source 1 (an old same-grid decision, past any retry bound)', { timeout: 60_000 }, async () => {
    env.step = 300_000;
    env.candleAt = candle;
    const old = G - 30 * DAY + 13_000;
    env.decisions = [{ decision_id: '61', decided_at: String(Math.floor(old / 1000)), coin: 'BTC', timeframe: '5m', exchange: 'BINANCE', would_be_side: 1, price_at_decision: 100 }];
    const { evidence } = await run(['--per-cell', '3', '--max-decisions', '10']);
    expect(env.inserted.filter((r) => Number(r[0]) === 61 && String(r[1]).endsWith('-v1'))).toHaveLength(3);
    expect(env.inserted.filter((r) => Number(r[0]) === 61 && String(r[1]).endsWith('-v2'))).toHaveLength(3);
    expect(evidence).toMatchObject({ v2_retry_candidates: 0 });
  });

  it('an OLD coarser decision whose -v1 decides tonight is held to the retry bound too — never outcome-selected -v2', { timeout: 60_000 }, async () => {
    const served = servedCandleStepMs('GATE', '3m')!;
    env.step = served;
    const e = G - 30 * DAY + 2 * M + 17_000;
    const touch = Math.ceil(e / served) * served + served;
    env.candleAt = (t) => (t === touch ? { ...flatC(t), high: 101 } : flatC(t));
    env.decisions = [gate(17, '3m', e)];
    const { evidence } = await run(['--per-cell', '3', '--max-decisions', '10']);
    expect(rowsOf(17, '-v1')).toHaveLength(3); // decided inside the cut
    expect(rowsOf(17, '-v2')).toHaveLength(0); // past the bound — as a cut timeout of the same age would be
    expect(evidence).toMatchObject({ v2_candidates: 0 });
  });

  it('only the unscoped (last) leg of a nightly calls a row lost; a per-venue leg reports it pending', { timeout: 60_000 }, async () => {
    env.step = DAY;
    env.candleAt = flatC;
    const now = Math.floor(G / DAY) * DAY + 10 * DAY + 3 * H + 41 * M;
    env.decisions = [mkRow(71, now - 5.5 * DAY), mkRow(72, now - 3.5 * DAY, { coin: 'FIL' })];
    seedV1(71);
    env.serveUntil = now;
    env.onFetch = () => vi.setSystemTime(new Date(Date.now() + 2 * 60_000)); // the -v2 pass never gets budget
    const scoped = await run(['--venue', 'BINANCE', '--per-cell', '3', '--max-decisions', '10', '--time-budget-min', '1'], now);
    expect(scoped.evidence).toMatchObject({ v2_retry_aged_out: 0, v2_retry_pending: 2 });
    env.decisions.push(mkRow(73, now - 3.5 * DAY, { coin: 'GRT' })); // fresh -v1 work that spends the budget again
    const last = await run(['--per-cell', '3', '--max-decisions', '10', '--time-budget-min', '1'], now);
    expect(last.evidence).toMatchObject({ v2_retry_aged_out: 1 });
  });

  it('a capped retry list races the most URGENT rows, and last-chance rows past the cap are counted aged out', { timeout: 60_000 }, async () => {
    env.step = DAY;
    env.candleAt = flatC;
    const now = Math.floor(G / DAY) * DAY + 10 * DAY + 3 * H + 41 * M;
    // 81 (coin ZZZ) and 82 (coin YYY): both on their last retryable nightly; 83 (AAA): can still wait a nightly
    env.decisions = [mkRow(81, now - 5.5 * DAY, { coin: 'ZZZ' }), mkRow(82, now - 5.4 * DAY, { coin: 'YYY' }), mkRow(83, now - 4.5 * DAY, { coin: 'AAA' })];
    seedV1(81); seedV1(82); seedV1(83);
    env.serveUntil = now;
    const { evidence } = await run(['--per-cell', '3', '--max-decisions', '1'], now);
    expect(rowsOf(81, '-v2')).toHaveLength(3); // the most urgent, though last alphabetically
    expect(rowsOf(83, '-v2')).toHaveLength(0);
    expect(evidence).toMatchObject({ v2_retry_limited: 1, v2_retry_overflow_last_chance: 1, v2_retry_aged_out: 1, v2_retry_written: 1 });
  });

  it('a decision the -v1 loop raced but wrote NOTHING for is not source 1 (same-grid, the -v1 forward came back empty once)', { timeout: 60_000 }, async () => {
    const e = G - 30 * DAY + 13_000; // old: past any retry bound, so only source 1 could ever reach it
    env.decisions = [{ decision_id: 18, decided_at: Math.floor(e / 1000), coin: 'BTC', timeframe: '5m', exchange: 'BINANCE', would_be_side: 1, price_at_decision: 100 }];
    env.emptyForwardAtEnd = { end: Math.floor(e / 1000) * 1000 + 14 * TF, entry: Math.floor(e / 1000) * 1000, v1Only: true };
    const { evidence } = await run(['--per-cell', '3', '--max-decisions', '10']);
    expect(rowsOf(18, '-v1')).toHaveLength(0);
    expect(rowsOf(18, '-v2')).toHaveLength(0);
    expect(evidence).toMatchObject({ v2_candidates: 0 });
  });
});
