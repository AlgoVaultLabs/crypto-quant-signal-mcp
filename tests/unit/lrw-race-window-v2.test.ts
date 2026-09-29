import { describe, it, expect, vi, beforeAll } from 'vitest';

// EDGE-LABELER-RACE-WINDOW-V2-W1 CH2 — the race-window regression suite.
//
// THE DEFECT (20129e14 → 3899ab71). `processGroup` extended the group candle cache from `coveredUntil + tf`,
// where `coveredUntil = entry_prev + (W+2)·tf` is off the candle grid whenever the previous row's created_at
// is (created_at is arbitrary seconds). `fetchRangeInto` keeps only `open >= start`, so the grid candle
// opening inside (coveredUntil, coveredUntil + tf) was never requested, and `runTripleBarrier` scans
// `forwardAsc.slice(0, W)` BY INDEX: the race skipped a candle and ran past its vertical barrier. The same
// hole sat in later rows' σ history; finer-served pairs also lost one candle per page boundary.
//
// This file drives the REAL `processGroup` with the DB and the adapter replaced at the golden test's seams
// (R0.1's fixture, inverted: it documented the defect on the old code; it pins the fix on the new). Nothing in
// src/ is copied — the model arithmetic here (`trueWindow`, `legacyExtensionStart`) is what the code is
// checked AGAINST. Its sibling mutation matrix lives in scripts/gates/lrw-ch2-gate.sh.

type C = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Sig = { id: number; created_at: number; price_at_signal: number; signal: 'BUY' | 'SELL'; pfe_return_pct: number; mae_return_pct: number };

// ── seams ─────────────────────────────────────────────────────────────────────────────────────────────
const env = vi.hoisted(() => ({
  signals: new Map<string, Sig[]>(), // exchange|coin|timeframe → the group's signals, created_at ASC
  candles: new Map<string, C[]>(), // exchange|coin|timeframe → EVERY candle the venue serves, on its grid
  pageCap: new Map<string, number>(), // exchange|coin|timeframe → the venue's page size (default 1000)
  budgetSkipFrom: Infinity, // a fetch whose range starts at/after this throws WeightBudgetSkipError (venue saturated)
  serveUntil: Infinity, // the venue serves only candles that have OPENED by "now"
  // 'window': OKX/Bitget history paging — one page = the candles in [start, start + cap·step); an EMPTY window
  // answers with the venue's NEWEST cap candles instead (okx.ts / bitget.ts behaviour, reproduced not imported)
  paging: new Map<string, { mode: 'window'; stepMs: number }>(),
  calls: [] as Array<{ start: number; end?: number; returned: number[] }>,
  inserted: [] as unknown[][],
  store: [] as unknown[][], // every row inserted since the last non-persisting run — the existing-rows read
}));
vi.mock('../../src/lib/performance-db.js', () => ({
  dbExec: () => undefined,
  dbQuery: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM signals') && sql.includes('WHERE exchange = $1 AND coin = $2 AND timeframe = $3')) {
      return env.signals.get(`${params[0]}|${params[1]}|${params[2]}`) ?? [];
    }
    if (sql.includes('SELECT signal_id, barrier_spec FROM directional_labels')) {
      const [specs, ids] = params as [string[], number[]];
      return env.store.filter((r) => specs.includes(r[1] as string) && ids.includes(r[0] as number)).map((r) => ({ signal_id: r[0], barrier_spec: r[1] }));
    }
    if (sql.includes('INSERT INTO directional_labels')) {
      const cols = (sql.match(/\(([^)]*)\)\s*VALUES/) ?? ['', ''])[1].split(',').length;
      const rows: unknown[][] = [];
      for (let i = 0; i < params.length; i += cols) rows.push(params.slice(i, i + cols));
      env.inserted.push(...rows);
      env.store.push(...rows);
      return rows.map((r) => ({ signal_id: r[0] }));
    }
    throw new Error(`unexpected SQL in lrw race-window suite: ${sql.slice(0, 80)}`);
  },
}));
vi.mock('../../src/lib/exchange-adapter.js', () => ({
  getAdapter: (exchange: string) => ({
    // one page of the served candles opening at/after `start`, capped at the venue's page size; `end` recorded
    getCandles: async (coin: string, tf: string, start: number, _dex: unknown, end?: number) => {
      const key = `${exchange}|${coin}|${tf}`;
      if (start >= env.budgetSkipFrom) {
        const { WeightBudgetSkipError } = await import('../../src/lib/upstream-weight-budget.js');
        throw new WeightBudgetSkipError(exchange, 1);
      }
      const cap = env.pageCap.get(key) ?? 1000;
      const served = (env.candles.get(key) ?? []).filter((c) => c.time <= env.serveUntil);
      const paging = env.paging.get(key);
      let page: C[];
      if (paging) {
        page = served.filter((c) => c.time >= start && c.time < start + cap * paging.stepMs);
        if (page.length === 0) page = served.slice(-cap);
      } else {
        page = served.filter((c) => c.time >= start).slice(0, cap);
      }
      env.calls.push({ start, end, returned: page.map((c) => c.time) });
      return page;
    },
  }),
}));

import {
  processGroup, parseCli, INSERT_COLUMNS, servedStepMs, addV1Extent, withinExtents, sealEdgeRow,
  _coverageForTest, formatV2Tokens, coarserV1LagMs, coarserV1LagTable, renderCoarserV1LagTable, NIGHTLY_CADENCE_MS,
} from '../../src/scripts/backfill-directional-labels.js';
import { readFileSync } from 'node:fs';
import { T_DIAG_END, withinTCap } from '../../src/scripts/ads1/spec.js';
import {
  EVAL_CANDLES, TF_MS, BARRIER_SPECS, BARRIER_SPECS_V2, SIGMA_TARGET_WINDOWS, computeSigmaW, barrierPct, runTripleBarrier,
  servedWindow, windowClosed, nextFetchStartMs, advanceCoverage, firstSlotAtOrAfter, raceGapCandles,
  contiguousTrailingCloses, prepareRaceV2, expiryReturnPct,
} from '../../src/scripts/directional-labeler.js';
import { servedCandleStepMs } from '../../src/lib/tf-support.js';
import { servedIntervalMs as S_HL } from '../../src/lib/adapters/hyperliquid.js';
import { servedIntervalMs as S_BINANCE } from '../../src/lib/adapters/binance.js';
import { servedIntervalMs as S_BYBIT } from '../../src/lib/adapters/bybit.js';
import { servedIntervalMs as S_OKX } from '../../src/lib/adapters/okx.js';
import { servedIntervalMs as S_BITGET } from '../../src/lib/adapters/bitget.js';
import { servedIntervalMs as S_ASTER } from '../../src/lib/adapters/aster.js';
import { servedIntervalMs as S_EDGEX } from '../../src/lib/adapters/edgex.js';
import { servedIntervalMs as S_GATE } from '../../src/lib/adapters/gateio.js';
import { servedIntervalMs as S_MEXC } from '../../src/lib/adapters/mexc.js';
import { servedIntervalMs as S_KUCOIN } from '../../src/lib/adapters/kucoin.js';
import { servedIntervalMs as S_PHEMEX } from '../../src/lib/adapters/phemex.js';
import { servedIntervalMs as S_BINGX } from '../../src/lib/adapters/bingx.js';
import { servedIntervalMs as S_HTX } from '../../src/lib/adapters/htx.js';
import { servedIntervalMs as S_WEEX } from '../../src/lib/adapters/weex.js';
import { servedIntervalMs as S_BITMART } from '../../src/lib/adapters/bitmart.js';
import { servedIntervalMs as S_XT } from '../../src/lib/adapters/xt.js';
import { servedIntervalMs as S_WHITEBIT } from '../../src/lib/adapters/whitebit.js';

// ── fixture helpers ───────────────────────────────────────────────────────────────────────────────────
const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const T = 497_000 * H; // 2026-09-12T08:00:00Z — epoch-aligned, as most venues' candles are
const OFF_GRID_MS = 30 * M + 17_000; // real created_at values are arbitrary seconds
const PX = 100;
const col = (name: (typeof INSERT_COLUMNS)[number]) => INSERT_COLUMNS.indexOf(name);
const V1 = new Set<string>(BARRIER_SPECS.map((s) => s.spec));
const V2 = new Set<string>(BARRIER_SPECS_V2.map((s) => s.spec));

const flat = (time: number): C => ({ time, open: PX, high: PX * 1.0005, low: PX * 0.9995, close: PX, volume: 1 });
const upTouch = (time: number): C => ({ ...flat(time), high: PX * 1.004 }); // clears a 0.30 % upper barrier
const downTouch = (time: number): C => ({ ...flat(time), low: PX * 0.996 }); // clears a 0.30 % lower barrier
function series(from: number, to: number, step: number, at: (t: number) => C = flat): C[] {
  const out: C[] = [];
  for (let t = from; t <= to; t += step) out.push(at(t));
  return out;
}
const sig = (id: number, entryMs: number, signal: 'BUY' | 'SELL' = 'BUY', price = PX): Sig => ({
  id, created_at: entryMs / 1000, price_at_signal: price, signal, pfe_return_pct: 5, mae_return_pct: -5,
});

/** THE MODEL of the retired extension: next fetch start = the previous range END + tf (off the grid). */
const legacyExtensionStart = (coveredUntil: number, tfMs: number) => coveredUntil + tfMs;
/** The W served-grid candles a gap-free race scans (epoch-aligned grid): the first at/after the entry, then W−1. */
function trueWindow(entryMs: number, servedMs: number, W: number): number[] {
  const open0 = Math.ceil(entryMs / servedMs) * servedMs;
  return Array.from({ length: W }, (_, i) => open0 + i * servedMs);
}

interface Run { calls: Array<{ start: number; end?: number; returned: number[] }>; inserted: unknown[][] }
async function runGroup(
  exchange: string, coin: string, timeframe: string, sigs: Sig[], candles: C[], pageCap?: number, nowMs = T + 400 * D,
  opts: { serveOnlyOpened?: boolean; windowPaging?: boolean; persist?: boolean } = {},
): Promise<Run> {
  const key = `${exchange}|${coin}|${timeframe}`;
  env.signals.set(key, sigs);
  env.candles.set(key, candles);
  if (pageCap) env.pageCap.set(key, pageCap);
  if (opts.windowPaging) env.paging.set(key, { mode: 'window', stepMs: servedStepMs(exchange, timeframe) });
  else env.paging.delete(key);
  env.serveUntil = opts.serveOnlyOpened ? nowMs : Infinity;
  env.calls.length = 0;
  env.inserted.length = 0;
  if (!opts.persist) env.store.length = 0; // a persisting run sees the rows the previous runs wrote
  vi.useFakeTimers({ toFake: ['Date'] }); // only Date: the fetch delays stay real
  vi.setSystemTime(new Date(nowMs));
  try {
    await processGroup(parseCli([]), { exchange, coin, timeframe });
  } finally {
    vi.useRealTimers();
    env.serveUntil = Infinity;
    env.budgetSkipFrom = Infinity;
  }
  return { calls: env.calls.map((c) => ({ ...c, returned: [...c.returned] })), inserted: env.inserted.map((r) => [...r]) };
}
/** What the fetches CACHED: every returned candle inside its range. */
const cached = (run: Run) => new Set(run.calls.flatMap((c) => c.returned.filter((t) => c.end === undefined || t <= c.end)));
const requested = (run: Run, t: number) => run.calls.some((c) => t >= c.start && (c.end === undefined || t <= c.end));
const rowsOf = (run: Run, id: number, family: Set<string>) =>
  run.inserted.filter((r) => r[col('signal_id')] === id && family.has(r[col('barrier_spec')] as string));
const forwardFromCache = (run: Run, entryMs: number) => [...cached(run)].filter((t) => t >= entryMs).sort((a, b) => a - b);

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// THE HOLE, FIXED — same-grid venue (BINANCE 1h, W = 8), two off-grid BUY rows (R0.1's fixture).
//   A at T+0:30:17; B at T+5:18 → B's true window T+6h … T+13h. The ONLY target touch is T+11h — the candle
//   the retired extension dropped; the only adverse touch is T+14h, one slot past B's vertical barrier.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('the corrected cache: an off-grid extension no longer drops a candle', () => {
  const tf = '1h';
  const W = EVAL_CANDLES[tf];
  const tfMs = TF_MS[tf];
  const A = T + OFF_GRID_MS;
  const B = T + 5 * H + 18 * M;
  const HOLE = T + 11 * H;
  const candles = series(T - 800 * H, T + 100 * H, H, (t) => (t === HOLE ? upTouch(t) : t === T + 14 * H ? downTouch(t) : flat(t)));
  let run: Run;
  beforeAll(async () => {
    expect(servedStepMs('BINANCE', tf)).toBe(tfMs);
    run = await runGroup('BINANCE', 'LRW', tf, [sig(1, A), sig(2, B)], candles);
  }, 30_000);

  it('the model: the RETIRED arithmetic would have started past the hole; the corrected start is at/before it', () => {
    const firstEnd = run.calls[0].end as number; // A's range end: entry + (W+2)·tf, off the grid
    expect(firstEnd % tfMs).not.toBe(0);
    expect(legacyExtensionStart(firstEnd, tfMs)).toBeGreaterThan(HOLE); // T+11:30:17 — the hole is skipped
    const ext = run.calls.find((c) => c.start > firstEnd)!; // B's extension
    expect(ext).toBeDefined();
    expect(ext.start).toBeLessThanOrEqual(HOLE); // T+11h: the next served boundary after the last arrival
    expect(ext.start % tfMs).toBe(0);
  });

  it('(a) every candle of the later row\'s true window was requested and cached', () => {
    const have = cached(run);
    expect(trueWindow(B, tfMs, W).filter((t) => !have.has(t))).toEqual([]);
    expect(requested(run, HOLE)).toBe(true);
  });

  it('(b) the -v1 race scanned W candles over W grid slots — never past its vertical barrier', () => {
    const scan = forwardFromCache(run, B).slice(0, W);
    expect(scan[W - 1] - scan[0]).toBe((W - 1) * tfMs);
    for (const r of rowsOf(run, 2, V1)) {
      expect(r[col('label')]).toBe(1); // T+11h is raced: target first
      expect(r[col('t_hit_candles')]).toBe(6);
      expect(r[col('race_gap_candles')]).toBe(0);
    }
  });

  it('(c) both families write the gap-free label; the first row is unaffected', () => {
    const byTime = new Map(candles.map((c) => [c.time, c]));
    const trueFwd = trueWindow(B, tfMs, W).map((t) => byTime.get(t)!);
    for (const sp of BARRIER_SPECS) {
      const gapFree = runTripleBarrier('BUY', PX, trueFwd, barrierPct(0, sp.tau), W); // flat history: σ = 0 → floor
      const v1 = rowsOf(run, 2, V1).find((r) => r[col('barrier_spec')] === sp.spec)!;
      const v2 = rowsOf(run, 2, V2).find((r) => r[col('barrier_spec')] === sp.spec.replace(/-v1$/, '-v2'))!;
      expect(v1[col('label')]).toBe(gapFree.label);
      expect(v2[col('label')]).toBe(gapFree.label);
      expect(v2[col('t_hit_candles')]).toBe(gapFree.tHitCandles);
      expect(v2[col('race_gap_candles')]).toBe(0);
      expect(v2[col('low_vol_history')]).toBe(false);
    }
    const aFwd = trueWindow(A, tfMs, W).map((t) => byTime.get(t)!);
    for (const r of [...rowsOf(run, 1, V1), ...rowsOf(run, 1, V2)]) {
      expect(r[col('label')]).toBe(runTripleBarrier('BUY', PX, aFwd, r[col('barrier_pct')] as number, W).label);
    }
    expect(rowsOf(run, 1, V2)).toHaveLength(3);
    expect(rowsOf(run, 2, V2)).toHaveLength(3);
  });
});

describe('the same hole beyond the race window, fixed', () => {
  it('σ_w: every row\'s stored barrier is the gap-free one — in BOTH families', { timeout: 30_000 }, async () => {
    const tf = '1h';
    const W = EVAL_CANDLES[tf];
    let s = 7 >>> 0;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    let p = PX;
    const candles = series(T - 800 * H, T + 200 * H, H, (t) => {
      const open = p;
      const close = Math.max(0.01, open * (1 + (rnd() - 0.5) * 0.02));
      p = close;
      return { time: t, open, high: Math.max(open, close) * (1 + rnd() * 0.004), low: Math.min(open, close) * (1 - rnd() * 0.004), close, volume: 1 };
    });
    // rows 20 h apart: the retired extension's hole landed inside each later row's σ history
    const entries = [0, 1, 2, 3].map((k) => T + k * 20 * H + OFF_GRID_MS);
    const closeBefore = (e: number) => candles.filter((c) => c.time < e).at(-1)!.close;
    const run = await runGroup('BINANCE', 'LRWS', tf, entries.map((e, k) => sig(21 + k, e, k % 2 ? 'SELL' : 'BUY', closeBefore(e))), candles);
    entries.forEach((e, k) => {
      const gapFreeSigma = computeSigmaW(candles.filter((c) => c.time < e).map((c) => c.close), W).sigma;
      expect(gapFreeSigma).not.toBeNull();
      for (const fam of [V1, V2]) {
        const rows = rowsOf(run, 21 + k, fam);
        expect(rows).toHaveLength(3);
        for (const r of rows) {
          const tau = [...BARRIER_SPECS, ...BARRIER_SPECS_V2].find((x) => x.spec === r[col('barrier_spec')])!.tau;
          expect(r[col('barrier_pct')]).toBe(barrierPct(gapFreeSigma, tau));
        }
      }
    });
  });

  it('finer-served pair (GATE 2h served as 1h): pages step by the SERVED interval; no candle lost at a boundary or an extension', { timeout: 30_000 }, async () => {
    const tf = '2h';
    const W = EVAL_CANDLES[tf]; // 6 served (1h) candles
    const served = servedStepMs('GATE', tf);
    expect(served).toBe(H);
    const A = T + OFF_GRID_MS;
    const B = T + 14 * H + 18 * M; // true window T+15h … T+20h
    const candles = series(T - 800 * H, T + 100 * H, H, (t) => (t === T + 17 * H ? upTouch(t) : t === T + 22 * H ? downTouch(t) : flat(t)));
    const run = await runGroup('GATE', 'LRWF', tf, [sig(31, A), sig(32, B)], candles, 200); // gateio.ts: limit 200
    const have = cached(run);
    // every page after the first starts one SERVED step after the previous page's last candle
    for (let i = 1; i < run.calls.length; i++) {
      const prev = run.calls[i - 1];
      if (prev.end === run.calls[i].end && prev.returned.length) expect(run.calls[i].start).toBe(Math.max(...prev.returned) + served);
    }
    const lo = Math.min(...cached(run));
    const hi = Math.max(...cached(run));
    expect(series(lo, hi, H).map((c) => c.time).filter((t) => !have.has(t))).toEqual([]); // contiguous, end to end
    expect(trueWindow(B, served, W).filter((t) => !have.has(t))).toEqual([]);
    for (const fam of [V1, V2]) {
      for (const r of rowsOf(run, 32, fam)) {
        expect(r[col('label')]).toBe(1); // T+17h is the 3rd served candle: target first
        expect(r[col('t_hit_candles')]).toBe(3);
        expect(r[col('race_gap_candles')]).toBe(0);
      }
    }
  });

  it('coarser-served pair (GATE 3m served as 5m): -v1 keeps its registered cut window (LRW-Q4); -v2 races W served candles', { timeout: 30_000 }, async () => {
    const tf = '3m';
    const W = EVAL_CANDLES[tf]; // 12
    const served = servedStepMs('GATE', tf);
    expect(served).toBe(5 * M);
    const e1 = T - 80 * H + 2 * M + 17_000; // flat → a gap-free timeout
    const e2 = T - 40 * H + 2 * M + 17_000; // target at the 10th served candle
    const e3 = T + 2 * M + 17_000; // target at the 3rd served candle
    const touch2 = trueWindow(e2, served, W)[9];
    const touch3 = trueWindow(e3, served, W)[2];
    const candles = series(T - 130 * H, T + 10 * H, served, (t) => (t === touch2 || t === touch3 ? upTouch(t) : flat(t)));
    const run = await runGroup('GATE', 'LRWK', tf, [sig(41, e1), sig(42, e2), sig(43, e3)], candles, 200);
    // -v1: exactly its registered self — only the race decided inside (W+2)·3m is written, never a timeout
    expect([...new Set(run.inserted.filter((r) => V1.has(r[col('barrier_spec')] as string)).map((r) => r[col('signal_id')]))]).toEqual([43]);
    for (const r of rowsOf(run, 43, V1)) {
      expect(r[col('label')]).toBe(1);
      expect(r[col('t_hit_candles')]).toBe(3);
      // the true window's last 4 served slots lie beyond -v1's (W+2)·3m cut: counted, the replay's "tail" class
      expect(r[col('race_gap_candles')]).toBe(4);
    }
    // -v2: W served candles by time — for the signal whose -v1 row this run wrote AND for the two whose -v1
    // timeout the registered cut makes unwritable (41 flat, 42 touching past the cut). Without them nightly
    // coarser -v2 would exist only where -v1 DECIDED: a population selected on the outcome.
    expect([...new Set(run.inserted.filter((r) => V2.has(r[col('barrier_spec')] as string)).map((r) => r[col('signal_id')]))]).toEqual([41, 42, 43]);
    const byTime = new Map(candles.map((c) => [c.time, c]));
    for (const [id, e] of [[41, e1], [42, e2], [43, e3]] as const) {
      const ref = runTripleBarrier('BUY', PX, trueWindow(e, served, W).map((t) => byTime.get(t)!), 0.3, W);
      const rows = rowsOf(run, id, V2);
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r[col('label')]).toBe(ref.label);
        expect(r[col('t_hit_candles')]).toBe(ref.tHitCandles);
        expect(r[col('race_gap_candles')]).toBe(0);
      }
    }
    expect([41, 42, 43].map((id) => rowsOf(run, id, V2)[0][col('label')])).toEqual([0, 1, 1]);
    expect(rowsOf(run, 41, V1)).toHaveLength(0); // -v1 itself is unchanged: its cut timeout is still never written
  });

  it('coarser-served: a -v2 window still OPEN when -v1 is due holds the WHOLE signal back — the first run after it closes writes both families', { timeout: 30_000 }, async () => {
    const tf = '3m';
    const W = EVAL_CANDLES[tf]; // 12; -v1 due at (W+1)·3m = 39 min, the -v2 window closes at (W+1)·5m = 65 min
    const served = servedStepMs('GATE', tf);
    const e = T + 2 * M + 17_000;
    const candles = series(T - 130 * H, T + 10 * H, served, (t) => (t === trueWindow(e, served, W)[0] ? upTouch(t) : flat(t)));
    const c0 = _coverageForTest();
    const night1 = await runGroup('GATE', 'LRWD', tf, [sig(44, e)], candles, 200, e + 50 * M, { serveOnlyOpened: true });
    expect(night1.inserted).toHaveLength(0); // neither family: the signal stays in the -v1-keyed worklist
    const c1 = _coverageForTest();
    expect([c1.v2HeldBack - c0.v2HeldBack, c1.v2HeldBackReleased - c0.v2HeldBackReleased]).toEqual([1, 0]); // V2_HELDBACK pending
    const night2 = await runGroup('GATE', 'LRWD', tf, [sig(44, e)], candles, 200, e + 50 * M + NIGHTLY_CADENCE_MS, { serveOnlyOpened: true, persist: true });
    expect(rowsOf(night2, 44, V1)).toHaveLength(3);
    expect(rowsOf(night2, 44, V2)).toHaveLength(3);
    for (const r of rowsOf(night2, 44, V1)) expect(r[col('label')]).toBe(1); // the same -v1 value, the next nightly
    const c2 = _coverageForTest();
    expect([c2.v2HeldBack - c1.v2HeldBack, c2.v2HeldBackReleased - c1.v2HeldBackReleased]).toEqual([0, 1]); // released
    // the estimate's other side: a run whose nominal predecessor came BEFORE -v1 was due releases nothing
    const late = await runGroup('GATE', 'LRWD2', tf, [sig(43, e)], candles, 200, e + 30 * M + NIGHTLY_CADENCE_MS, { serveOnlyOpened: true });
    expect(rowsOf(late, 43, V1)).toHaveLength(3);
    expect(_coverageForTest().v2HeldBackReleased - c2.v2HeldBackReleased).toBe(0);
    // the lag this pair can cost -v1: (W+1)·(5m − 3m)
    expect(coarserV1LagMs('GATE', tf)).toBe((W + 1) * 2 * M);
    // control — a SAME-grid pair is never deferred: both families at the first run after -v1 is due
    const e5 = T + 2 * M + 17_000;
    const W5 = EVAL_CANDLES['5m'];
    expect(servedStepMs('GATE', '5m')).toBe(5 * M);
    const c5 = series(T - 130 * H, T + 10 * H, 5 * M, (t) => (t === trueWindow(e5, 5 * M, W5)[0] ? upTouch(t) : flat(t)));
    const due = await runGroup('GATE', 'LRWE', '5m', [sig(45, e5)], c5, 200, e5 + (W5 + 1) * 5 * M + M, { serveOnlyOpened: true });
    expect(rowsOf(due, 45, V1)).toHaveLength(3);
    expect(rowsOf(due, 45, V2)).toHaveLength(3);
  });

  it('coarser-served σ and expiry: -v1 σ on its (60W+2)·requested cut, -v2 σ on 60W served windows, -v2 expiry inline', { timeout: 30_000 }, async () => {
    const tf = '3m';
    const W = EVAL_CANDLES[tf];
    const served = servedStepMs('GATE', tf);
    let s = 23 >>> 0;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const e = T + 2 * M + 17_000;
    const open0 = trueWindow(e, served, W)[0];
    let p = PX;
    let entryPx = PX;
    const candles = series(T - 130 * H, T + 10 * H, served, (t) => {
      const open = p;
      const close = Math.max(0.01, open * (1 + (rnd() - 0.5) * 0.01));
      p = close;
      if (t < e) entryPx = close;
      const c = { time: t, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 1 };
      return t === open0 ? { ...c, high: entryPx * 1.5, low: entryPx } : c; // decided on the 1st served candle
    });
    const run = await runGroup('GATE', 'LRWR', tf, [sig(46, e, 'BUY', entryPx)], candles, 200);
    const tauOf = (r: unknown[]) => [...BARRIER_SPECS, ...BARRIER_SPECS_V2].find((x) => x.spec === r[col('barrier_spec')])!.tau;
    // (a) -v1: σ from exactly its registered extent [e − (60W+2)·3m, e) — 36 windows of served closes
    const lo = e - (SIGMA_TARGET_WINDOWS * W + 2) * TF_MS[tf];
    const v1Sigma = computeSigmaW(candles.filter((c) => c.time >= lo && c.time < e).map((c) => c.close), W).sigma;
    // (b) -v2: σ from the last 60W+1 contiguous served closes before the window
    const byTime = new Map(candles.map((c) => [c.time, c]));
    const v2Closes = Array.from({ length: SIGMA_TARGET_WINDOWS * W + 1 }, (_, i) => byTime.get(open0 - (SIGMA_TARGET_WINDOWS * W + 1 - i) * served)!.close);
    const v2Sigma = computeSigmaW(v2Closes, W).sigma;
    expect(v1Sigma).not.toBeNull();
    expect(v2Sigma).not.toBeNull();
    expect(v1Sigma).not.toBe(v2Sigma); // (c) non-vacuous: the two cuts give two barriers
    for (const r of rowsOf(run, 46, V1)) expect(r[col('barrier_pct')]).toBe(barrierPct(v1Sigma, tauOf(r)));
    for (const r of rowsOf(run, 46, V2)) expect(r[col('barrier_pct')]).toBe(barrierPct(v2Sigma, tauOf(r)));
    expect(rowsOf(run, 46, V1)).toHaveLength(3);
    expect(rowsOf(run, 46, V2)).toHaveLength(3);
    for (const r of rowsOf(run, 46, V1)) expect(barrierPct(v1Sigma, tauOf(r))).toBeGreaterThan(0.3); // off the floor
    // (d) the expiry is the W-th SERVED close, inline in both families (LRW-Q9e) — never NULL for want of the cut
    const expiry = (byTime.get(open0 + (W - 1) * served)!.close / entryPx - 1) * 100;
    for (const r of [...rowsOf(run, 46, V1), ...rowsOf(run, 46, V2)]) expect(r[col('ret_at_expiry_pct')]).toBe(expiry);
  });

  it('the -v1 view is the STRICT union of its requested extents: a served candle between two extents stays out', { timeout: 30_000 }, async () => {
    const tf = '3m';
    const W = EVAL_CANDLES[tf];
    const served = servedStepMs('GATE', tf);
    let s = 31 >>> 0;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const eA = T + 2 * M + 17_000;
    const hiA = eA + (W + 2) * TF_MS[tf]; // T+44:17
    const loB = hiA + 4 * M; // > one requested step past hiA, < one served step
    const eB = loB + (SIGMA_TARGET_WINDOWS * W + 2) * TF_MS[tf];
    const loA = eA - (SIGMA_TARGET_WINDOWS * W + 2) * TF_MS[tf];
    const between = series(T - 200 * H, T + 100 * H, served).map((c) => c.time).filter((t) => t > hiA && t < loB);
    expect(between).toHaveLength(1); // exactly one served open strictly between the two extents
    let p = PX;
    let pxB = PX;
    const touchB = trueWindow(eB, served, W)[0];
    const candles = series(T - 200 * H, T + 100 * H, served, (t) => {
      const open = p;
      const close = Math.max(0.01, open * (1 + (rnd() - 0.5) * 0.01));
      p = close;
      if (t < eB) pxB = close;
      const c = { time: t, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 1 };
      return t === touchB ? { ...c, high: pxB * 1.5, low: pxB } : c;
    });
    const run = await runGroup('GATE', 'LRWU', tf, [sig(47, eA), sig(48, eB, 'BUY', pxB)], candles, 200);
    const inUnion = (t: number) => (t >= loA && t <= hiA) || (t >= loB && t < eB);
    const strict = computeSigmaW(candles.filter((c) => inUnion(c.time)).map((c) => c.close), W).sigma;
    const bridged = computeSigmaW(candles.filter((c) => inUnion(c.time) || c.time === between[0]).map((c) => c.close), W).sigma;
    expect(strict).not.toBe(bridged); // non-vacuous: the candle between the extents moves σ
    const v1 = rowsOf(run, 48, V1);
    expect(v1).toHaveLength(3);
    for (const r of v1) {
      const tau = BARRIER_SPECS.find((x) => x.spec === r[col('barrier_spec')])!.tau;
      expect(r[col('barrier_pct')]).toBe(barrierPct(strict, tau));
    }
  });

  it('a venue that answers an EMPTY history window with its newest bars (OKX/Bitget): a young coin is not stuck behind its listing', { timeout: 60_000 }, async () => {
    const tf = '5m';
    const W = EVAL_CANDLES[tf];
    expect(servedStepMs('OKX', tf)).toBe(5 * M);
    const listing = T;
    const now = listing + 50 * H;
    const candles = series(listing, now, 5 * M, (t) => ((t / (5 * M)) % 7 === 3 ? upTouch(t) : flat(t))); // no history before listing
    const sigs = Array.from({ length: 20 }, (_, k) => sig(70 + k, listing + 30 * M + k * 23 * M + 17_000));
    const run = await runGroup('OKX', 'LRWY', tf, sigs, candles, 100, now, { serveOnlyOpened: true, windowPaging: true });
    const labelled = sigs.filter((x) => rowsOf(run, x.id, V1).length === 3).map((x) => x.id);
    // every row after the first reaches its candles (the retired `coveredUntil = neededEnd` did too); only the
    // first, whose whole range the venue answered with bars from outside it, has nothing to race
    expect(labelled).toEqual(sigs.slice(1).map((x) => x.id));
    expect(W).toBeGreaterThan(0);
  });

  it('the seal edge: a row ADS-1\'s T_CAP admits never carries a post-seal close in ret_at_expiry_pct', { timeout: 30_000 }, async () => {
    const tf = '3m';
    const W = EVAL_CANDLES[tf];
    const served = servedStepMs('GATE', tf);
    const SEAL = T_DIAG_END * 1000;
    const inBand = Math.floor((SEAL - 50 * M) / 1000) * 1000 + 23_000; // T_CAP admits it; its served race ends past the seal
    const below = Math.floor((SEAL - 70 * M) / 1000) * 1000 + 23_000; // its served race ends before the seal
    expect(withinTCap(inBand / 1000, tf)).toBe(true);
    expect(sealEdgeRow(inBand / 1000, tf, served)).toBe(true);
    expect(sealEdgeRow(below / 1000, tf, served)).toBe(false);
    expect(sealEdgeRow((SEAL + H) / 1000, tf, served)).toBe(false); // above T_CAP: not ADS-1's row
    expect(sealEdgeRow(inBand / 1000, '5m', 5 * M)).toBe(false); // same-grid: T_CAP already covers the race
    const touch = new Set([trueWindow(inBand, served, W)[0], trueWindow(below, served, W)[0]]);
    const candles = series(SEAL - 130 * H, SEAL + 10 * H, served, (t) => (touch.has(t) ? upTouch(t) : t >= SEAL ? { ...flat(t), close: 123 } : flat(t)));
    const run = await runGroup('GATE', 'LRWZ', tf, [sig(81, below), sig(82, inBand)], candles, 200, SEAL + 400 * D);
    for (const r of [...rowsOf(run, 82, V1), ...rowsOf(run, 82, V2)]) expect(r[col('ret_at_expiry_pct')]).toBeNull();
    expect(rowsOf(run, 82, V1)).toHaveLength(3);
    for (const r of [...rowsOf(run, 81, V1), ...rowsOf(run, 81, V2)]) expect(r[col('ret_at_expiry_pct')]).toBe(0);
    expect(rowsOf(run, 81, V1)).toHaveLength(3);
  });

  it('the hold-back waits on the CLOCK, never on the -v2 fetch: a refused -v2 window still writes -v1 in the same run', { timeout: 30_000 }, async () => {
    const tf = '3m';
    const W = EVAL_CANDLES[tf];
    const served = servedStepMs('GATE', tf);
    const e = T + 2 * M + 17_000;
    const win = trueWindow(e, served, W);
    // a touch on the 1st served candle (inside the -v1 cut); a hole on the 11th (inside -v2's window, past the cut)
    const candles = series(T - 130 * H, T + 10 * H, served, (t) => (t === win[0] ? upTouch(t) : flat(t))).filter((c) => c.time !== win[10]);
    const c0 = _coverageForTest();
    const run = await runGroup('GATE', 'LRWK2', tf, [sig(49, e)], candles, 200, e + D, { serveOnlyOpened: true });
    expect(rowsOf(run, 49, V1)).toHaveLength(3); // -v1 coverage is never reduced by a -v2 refusal
    expect(rowsOf(run, 49, V2)).toHaveLength(0); // refused — never raced across
    const c1 = _coverageForTest();
    expect([c1.v2Refused - c0.v2Refused, c1.v2HeldBack - c0.v2HeldBack]).toEqual([1, 0]);
  });

  it('LRW-Q16: a -v2 row without a -v1 twin is a named, counted class, written ONCE across the perpetual -v1 re-attempts', { timeout: 30_000 }, async () => {
    const tf = '3m';
    const served = servedStepMs('GATE', tf);
    const e = T + 2 * M + 17_000;
    const candles = series(T - 130 * H, T + 10 * H, served); // flat: -v1 is a cut timeout, never writable
    const c0 = _coverageForTest();
    const n1 = await runGroup('GATE', 'LRWT', tf, [sig(55, e)], candles, 200);
    expect(rowsOf(n1, 55, V1)).toHaveLength(0);
    expect(rowsOf(n1, 55, V2)).toHaveLength(3);
    const c1 = _coverageForTest();
    expect(c1.v2NoV1Twin - c0.v2NoV1Twin).toBe(3);
    // its -v2 window was long closed a nightly ago: nothing held it back, so nothing is "released"
    expect(c1.v2HeldBackReleased - c0.v2HeldBackReleased).toBe(0);
    const n2 = await runGroup('GATE', 'LRWT', tf, [sig(55, e)], candles, 200, T + 401 * D, { persist: true });
    expect(n2.inserted).toHaveLength(0); // re-attempted for -v1, -v2 not written again
    expect(_coverageForTest().v2NoV1Twin - c1.v2NoV1Twin).toBe(0);
    expect(formatV2Tokens({ v2HeldBack: 2, v2HeldBackReleased: 1, v2NoV1Twin: 3 })).toEqual([
      'V2_HELDBACK pending=2 released=1',
      'V2_NO_V1_TWIN written=3',
    ]);
    // the nightly prints them beside its DONE line (a source pin: main() is not driven here)
    const src = readFileSync('src/scripts/backfill-directional-labels.ts', 'utf8');
    expect(src).toMatch(/for \(const line of formatV2Tokens\(cov\)\) console\.log\(line\);\n\s+console\.log\(`\[\$\{ts\(\)\}\] DONE /);
  });

  /** GATE 3m (served 5m) signal at `e`: a random-walk history, then a forward whose 1st served candle clears τ0.5's
   *  barrier but not τ1.0's, flat after — so τ0.5 decides inside the -v1 cut and τ1.0 / τ2.0 are cut timeouts. */
  function mixedTauFixture(e: number, seed: number): { candles: C[]; px: number } {
    const tf = '3m';
    const W = EVAL_CANDLES[tf];
    const served = servedStepMs('GATE', tf);
    let sd = seed >>> 0;
    const rnd = () => ((sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const open0 = trueWindow(e, served, W)[0];
    let p = PX;
    const hist: C[] = [];
    for (let t = Math.floor((e - 130 * H) / served) * served; t < e; t += served) {
      const open = p;
      p = open * (1 + (rnd() - 0.5) * 0.005);
      hist.push({ time: t, open, high: Math.max(open, p) * 1.0002, low: Math.min(open, p) * 0.9998, close: p, volume: 1 });
    }
    const px = p;
    const lo = e - (SIGMA_TARGET_WINDOWS * W + 2) * TF_MS[tf];
    const sigma = computeSigmaW(hist.filter((c) => c.time >= lo).map((c) => c.close), W).sigma;
    const [b05, b10] = [barrierPct(sigma, 0.5), barrierPct(sigma, 1.0)];
    expect(b10).toBeGreaterThan(b05); // non-vacuous: the two τ have distinct barriers
    const touch = px * (1 + (b05 + b10) / 2 / 100); // clears τ0.5's barrier, not τ1.0's
    const fwd = series(Math.ceil(e / served) * served, e + 10 * H, served, (t) =>
      ({ time: t, open: px, high: t === open0 ? touch : px, low: px, close: px, volume: 1 }));
    return { candles: [...hist, ...fwd], px };
  }

  it('V2_NO_V1_TWIN is per τ: τ0.5 decided inside the cut, τ1.0 / τ2.0 cut timeouts → two twin-less -v2 rows', { timeout: 30_000 }, async () => {
    const e = T + 2 * M + 17_000;
    const { candles, px } = mixedTauFixture(e, 47);
    const c0 = _coverageForTest();
    const run = await runGroup('GATE', 'LRWM', '3m', [sig(57, e, 'BUY', px)], candles, 200);
    expect(rowsOf(run, 57, V1).map((r) => r[col('barrier_spec')])).toEqual(['tau0.5-floor0.30-v1']);
    expect(rowsOf(run, 57, V2)).toHaveLength(3);
    expect(_coverageForTest().v2NoV1Twin - c0.v2NoV1Twin).toBe(2); // τ1.0 and τ2.0 — never "0 because a -v1 was written"
  });

  it('V2_NO_V1_TWIN: a same-τ -v1 twin that ALREADY exists is a twin', { timeout: 30_000 }, async () => {
    const e = T + 2 * M + 17_000;
    const { candles, px } = mixedTauFixture(e, 47);
    env.store.length = 0;
    env.store.push([58, 'tau0.5-floor0.30-v1', 1, false, false, 1, 5, -5, 0.3, null, 0]); // written by an earlier run
    const c0 = _coverageForTest();
    const run = await runGroup('GATE', 'LRWM2', '3m', [sig(58, e, 'BUY', px)], candles, 200, T + 400 * D, { persist: true });
    expect(rowsOf(run, 58, V1)).toHaveLength(0); // τ0.5 present; τ1.0 / τ2.0 still cut timeouts
    expect(rowsOf(run, 58, V2)).toHaveLength(3);
    expect(_coverageForTest().v2NoV1Twin - c0.v2NoV1Twin).toBe(2);
  });

  it('V2_NO_V1_TWIN counts rows only once they are inserted: a group a budget skip abandons counts nothing', { timeout: 30_000 }, async () => {
    const tf = '3m';
    const served = servedStepMs('GATE', tf);
    const e1 = T + 2 * M + 17_000;
    const e2 = T + 300 * H + 2 * M + 17_000; // a new island: its fetch is refused by the saturated venue
    const candles = series(T - 130 * H, T + 400 * H, served); // flat: both are cut timeouts
    env.budgetSkipFrom = e2 - 200 * H;
    const c0 = _coverageForTest();
    const run = await runGroup('GATE', 'LRWB', tf, [sig(59, e1), sig(60, e2)], candles, 200);
    expect(run.inserted).toHaveLength(0); // the whole group is deferred to the next run
    const c1 = _coverageForTest();
    expect([c1.budgetSkips - c0.budgetSkips, c1.v2NoV1Twin - c0.v2NoV1Twin]).toEqual([1, 0]);
  });

  it('the coarser -v1 lag is a per-pair bound derived from the served table, and SoT §5 prints exactly that table', () => {
    // the ruling's values: (W+1)·(served − requested)
    expect(Object.fromEntries(coarserV1LagTable().map((r) => [`${r.venue} ${r.timeframe}`, [r.lagMs / M, r.nightlies]]))).toEqual({
      'GATE 3m': [26, 1], 'MEXC 3m': [26, 1], 'PHEMEX 3m': [26, 1], 'PHEMEX 12h': [3600, 3], 'HTX 3m': [26, 1], 'WEEX 3m': [26, 1],
      'XT 3m': [26, 1], 'WHITEBIT 3m': [156, 1], 'WHITEBIT 5m': [130, 1],
    });
    expect(coarserV1LagMs('BINANCE', '1h')).toBe(0); // same-grid
    expect(coarserV1LagMs('GATE', '2h')).toBe(0); // finer-served
    const doc = readFileSync('docs/Directional-Accuracy-SoT.md', 'utf8');
    const m = doc.match(/<!-- coarser-v1-lag:begin[^>]*-->\n([\s\S]*?)\n<!-- coarser-v1-lag:end -->/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(renderCoarserV1LagTable());
    expect(/one nightly|one night later|≤ ?1 night/i.test(doc)).toBe(false); // a per-pair bound, never a constant
  });

  it('a candle the VENUE never serves: -v1 races across it (counted), -v2 refuses — no row', { timeout: 30_000 }, async () => {
    const tf = '1h';
    const W = EVAL_CANDLES[tf];
    const B = T + 5 * H + 18 * M; // true window T+6h … T+13h
    const candles = series(T - 800 * H, T + 100 * H, H, (t) => (t === T + 12 * H ? upTouch(t) : t === T + 14 * H ? downTouch(t) : flat(t)))
      .filter((c) => c.time !== T + 11 * H);
    const run = await runGroup('BINANCE', 'LRWV', tf, [sig(51, B)], candles);
    const v1 = rowsOf(run, 51, V1);
    expect(v1).toHaveLength(3);
    for (const r of v1) {
      expect(r[col('race_gap_candles')]).toBe(1); // the provenance says so
      expect(r[col('label')]).toBe(1); // -v1's index race took T+12h as its 6th candle
    }
    expect(rowsOf(run, 51, V2)).toHaveLength(0); // refused, never raced across
    expect(servedWindow(forwardFromCache(run, B).map((t) => flat(t)), W, B, H)).toEqual({ ok: false, reason: 'gap' });
  });

  it('a venue whose daily candles open at 16:00Z (UTC+8 bars): the -v2 window is anchored from the data', { timeout: 30_000 }, async () => {
    const tf = '1d';
    const W = EVAL_CANDLES[tf]; // 3
    expect(servedStepMs('OKX', tf)).toBe(D);
    const PHASE = 16 * H;
    const day0 = Math.floor(T / D) * D + PHASE; // a 16:00Z open
    const entry = day0 + 4 * H + 17_000; // 20:00:17Z — the first open after it is the NEXT day's 16:00Z
    const candles = series(day0 - 400 * D, day0 + 20 * D, D, (t) => (t === day0 + 2 * D ? upTouch(t) : flat(t)));
    const run = await runGroup('OKX', 'LRWP', tf, [sig(61, entry)], candles);
    expect(Math.ceil(entry / D) * D % D).toBe(0); // an epoch-anchored window would start at 00:00Z…
    expect(candles.some((c) => c.time === Math.ceil(entry / D) * D)).toBe(false); // …where no candle opens
    const v2 = rowsOf(run, 61, V2);
    expect(v2).toHaveLength(3);
    for (const r of v2) {
      expect(r[col('label')]).toBe(1); // day0+2d is the 2nd candle of the data-anchored window
      expect(r[col('t_hit_candles')]).toBe(2);
    }
    for (const r of rowsOf(run, 61, V1)) expect(r[col('race_gap_candles')]).toBe(0); // gap counted on the venue's own phase
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// The extracted, shared derivations — pure.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('pure derivations shared by the race, expiry and hold paths', () => {
  it('nextFetchStartMs is bit-identical to the expiry path\'s inline arithmetic it replaced', () => {
    const inline = (cU: number, tf: number, entry: number) => {
      const nextOpen = (Math.floor(cU / tf) + 1) * tf;
      return nextOpen >= entry ? nextOpen : entry;
    };
    let s = 11;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (const tf of [3 * M, 5 * M, H, 2 * H, 12 * H, D]) {
      expect(nextFetchStartMs(-Infinity, tf, T)).toBe(inline(-Infinity, tf, T));
      for (let i = 0; i < 500; i++) {
        const cU = T + Math.floor(rnd() * 400 * tf) - 200 * tf;
        const entry = T + Math.floor(rnd() * 400 * tf) - 200 * tf;
        expect(nextFetchStartMs(cU, tf, entry)).toBe(inline(cU, tf, entry));
      }
    }
  });

  it('advanceCoverage moves only to a candle that arrived inside the range', () => {
    expect(advanceCoverage(-Infinity, [], 0, 10)).toBe(-Infinity);
    expect(advanceCoverage(5, [1, 3, 20], 4, 10)).toBe(5); // nothing arrived in [4, 10]
    expect(advanceCoverage(5, [6, 9, 12], 4, 10)).toBe(9);
    expect(advanceCoverage(50, [6, 9], 4, 10)).toBe(50); // never backwards
  });

  it('windowClosed is the entry-based (W+1)·step bound, inclusive', () => {
    expect(windowClosed(0, 8, H, 9 * H)).toBe(true);
    expect(windowClosed(0, 8, H, 9 * H - 1)).toBe(false);
  });

  it('servedWindow: anchor within one step, W consecutive steps — else a named refusal', () => {
    const fwd = series(T, T + 20 * H, H);
    expect(servedWindow(fwd, 8, T - 30 * M, H)).toMatchObject({ ok: true });
    expect((servedWindow(fwd, 8, T - 30 * M, H) as { window: C[] }).window).toHaveLength(8);
    expect(servedWindow(fwd.slice(0, 7), 8, T, H)).toEqual({ ok: false, reason: 'short' });
    expect(servedWindow(fwd.slice(1), 8, T - 30 * M, H)).toEqual({ ok: false, reason: 'anchor' });
    expect(servedWindow(fwd.filter((c) => c.time !== T + 3 * H), 8, T, H)).toEqual({ ok: false, reason: 'gap' });
    // an extra candle interleaved off the grid is not a race window either
    const odd = [...fwd.slice(0, 3), flat(T + 2 * H + 30 * M), ...fwd.slice(3)].sort((a, b) => a.time - b.time);
    expect(servedWindow(odd, 8, T, H)).toEqual({ ok: false, reason: 'gap' });
  });

  it('expiryReturnPct still reads the W-th candle of exactly that window', () => {
    const fwd = series(T, T + 20 * H, H).map((c, i) => ({ ...c, close: 100 + i }));
    expect(expiryReturnPct(fwd, 8, 100, T, H, T + 100 * H)).toBeCloseTo(7, 12);
    expect(expiryReturnPct(fwd.filter((c) => c.time !== T + 3 * H), 8, 100, T, H, T + 100 * H)).toBeNull();
  });

  it('firstSlotAtOrAfter / raceGapCandles follow the venue\'s own grid phase', () => {
    const phase = 16 * H;
    expect(firstSlotAtOrAfter(T + 20 * H, T + phase, D)).toBe(T + phase + D);
    expect(firstSlotAtOrAfter(T + 10 * H, T + phase, D)).toBe(T + phase);
    expect(firstSlotAtOrAfter(T + phase, T + phase, D)).toBe(T + phase);
    const opens = new Set([T + H, T + 2 * H, T + 4 * H, T + 5 * H]);
    expect(raceGapCandles(opens, T + 30 * M, 4, H, T + 2 * H)).toBe(1); // T+3h missing
    expect(raceGapCandles(opens, T + 30 * M, 5, H, T)).toBe(1);
    expect(raceGapCandles(new Set(), T, 3, H, T)).toBe(3);
  });

  it('contiguousTrailingCloses stops at the first missing slot and caps its length', () => {
    const byTime = new Map(series(T - 10 * H, T, H).map((c, i) => [c.time, { ...c, close: i }]));
    expect(contiguousTrailingCloses(byTime, T + H, H, 100)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(contiguousTrailingCloses(byTime, T + H, H, 3)).toEqual([8, 9, 10]);
    byTime.delete(T - 4 * H);
    expect(contiguousTrailingCloses(byTime, T + H, H, 100)).toEqual([7, 8, 9, 10]);
    expect(contiguousTrailingCloses(byTime, T - 4 * H + H, H, 100)).toEqual([]); // the slot before the window is the hole
  });

  it('prepareRaceV2: deferred · unreachable (depth, history) · refused · ready', () => {
    const W = 8;
    const entry = T + 30 * M;
    const all = series(T - 600 * H, T + 30 * H, H, (t) => ({ ...flat(t), close: PX * (1 + 0.001 * Math.sin(t / H)) }));
    const byTime = new Map(all.map((c) => [c.time, c]));
    const fwd = all.filter((c) => c.time >= entry);
    expect(prepareRaceV2(byTime, fwd, entry, W, H, entry + 9 * H - 1)).toEqual({ kind: 'deferred' });
    expect(prepareRaceV2(byTime, [], entry, W, H, T + 100 * H)).toEqual({ kind: 'unreachable', reason: 'depth' });
    const holed = fwd.filter((c) => c.time !== T + 4 * H);
    expect(prepareRaceV2(byTime, holed, entry, W, H, T + 100 * H)).toEqual({ kind: 'refused', reason: 'gap' });
    const shortHist = new Map([...byTime].filter(([t]) => t > T - 200 * H)); // < 30·W + 1 contiguous closes
    expect(prepareRaceV2(shortHist, fwd, entry, W, H, T + 100 * H)).toEqual({ kind: 'unreachable', reason: 'history' });
    const ok = prepareRaceV2(byTime, fwd, entry, W, H, T + 100 * H);
    expect(ok.kind).toBe('ready');
    if (ok.kind === 'ready') {
      expect(ok.window.map((c) => c.time)).toEqual(trueWindow(entry, H, W));
      expect(ok.nSigmaWindows).toBe(SIGMA_TARGET_WINDOWS);
      const hist = all.filter((c) => c.time < ok.window[0].time).slice(-(SIGMA_TARGET_WINDOWS * W + 1)).map((c) => c.close);
      expect(ok.sigma).toBe(computeSigmaW(hist, W).sigma);
    }
  });

  it('addV1Extent merges only OVERLAPPING extents (the strict union), and withinExtents clips to it', () => {
    const ext: Array<[number, number]> = [];
    addV1Extent(ext, 0, 10 * H);
    addV1Extent(ext, 5 * H, 12 * H); // overlaps: merged
    expect(ext).toEqual([[0, 12 * H]]);
    addV1Extent(ext, 12 * H + 30 * M, 20 * H); // under one tf past the end, but disjoint: its own extent
    expect(ext).toEqual([[0, 12 * H], [12 * H + 30 * M, 20 * H]]);
    addV1Extent(ext, 20 * H, 22 * H); // touching end-to-start: merged (the shared instant is in both)
    expect(ext).toEqual([[0, 12 * H], [12 * H + 30 * M, 22 * H]]);
    const asc = series(-2 * H, 32 * H, 30 * M);
    const inView = withinExtents(asc, ext).map((c) => c.time);
    expect(inView[0]).toBe(0);
    expect(inView.includes(12 * H)).toBe(true);
    expect(inView.includes(12 * H + 15 * M)).toBe(false); // strictly between two extents: outside the -v1 view
    expect(inView.includes(12 * H + 30 * M)).toBe(true);
    expect(inView.at(-1)).toBe(22 * H);
  });

  it('LRW-Q9(b): the extracted expiryReturnPct / advanceCoverage are Object.is-identical to the retired inline bodies on single-grid input', () => {
    // the origin/main (b11529bf) bodies, verbatim — the reference the extraction is checked against
    const retiredExpiry = (forwardAsc: C[], W: number, entryPrice: number, entryMs: number, tfMs: number, fetchedNotBeforeMs: number): number | null => {
      if (!(W > 0) || !(tfMs > 0) || !(entryPrice > 0)) return null;
      if (forwardAsc.length < W) return null;
      if (entryMs + (W + 1) * tfMs > fetchedNotBeforeMs) return null;
      const first = forwardAsc[0].time;
      if (!(first >= entryMs && first < entryMs + tfMs)) return null;
      if (forwardAsc[W - 1].time - first !== (W - 1) * tfMs) return null;
      const close = forwardAsc[W - 1].close;
      if (!Number.isFinite(close) || close <= 0) return null;
      return (close / entryPrice - 1) * 100;
    };
    const retiredAdvance = (cU: number, keys: number[], start: number, end: number): number => {
      let lastOpen = -Infinity;
      for (const t of keys) if (t >= start && t <= end && t > lastOpen) lastOpen = t;
      return Number.isFinite(lastOpen) ? Math.max(cU, lastOpen) : cU;
    };
    let s = 101 >>> 0;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const steps = [3 * M, 5 * M, 15 * M, 30 * M, H, 2 * H, 4 * H, 12 * H, D];
    let valued = 0;
    for (let n = 0; n < 20_000; n++) {
      const step = steps[Math.floor(rnd() * steps.length)];
      const W = 1 + Math.floor(rnd() * 12);
      const phase = Math.floor(rnd() * 3) === 0 ? 8 * H % step : 0; // UTC+8-anchored grids too
      const base = 497_000 * H + phase;
      const opens: number[] = [];
      for (let k = 0; k < W + 6; k++) if (rnd() > 0.1) opens.push(base + k * step);
      const candles = opens.map((t) => ({ ...flat(t), close: 50 + rnd() * 100 }));
      const entry = base + Math.floor((rnd() * 3 - 1) * step);
      const fwd = candles.filter((c) => c.time >= entry);
      const fetched = entry + Math.floor((W + 1 + (rnd() * 2 - 1)) * step);
      const a = retiredExpiry(fwd, W, 100, entry, step, fetched);
      const b = expiryReturnPct(fwd, W, 100, entry, step, fetched);
      expect(Object.is(a, b)).toBe(true);
      if (a !== null) valued++;
      const cU = rnd() < 0.3 ? -Infinity : base + Math.floor(rnd() * 4) * step;
      const st = base + Math.floor(rnd() * 4 * step);
      const en = st + Math.floor(rnd() * 8 * step);
      expect(Object.is(retiredAdvance(cU, opens, st, en), advanceCoverage(cU, opens, st, en))).toBe(true);
    }
    expect(valued).toBeGreaterThan(1000); // non-vacuous: the value branch is exercised, not only the nulls
    // off a single grid the two DO differ, by design: an off-grid open inside the window is refused (servedWindow)
    const odd = [0, 1, 2, 2.5, 4, 5, 6, 7, 8].map((k) => ({ ...flat(T + k * H), close: 100 + k }));
    expect(retiredExpiry(odd, 8, 100, T, H, T + 100 * H)).not.toBeNull();
    expect(expiryReturnPct(odd, 8, 100, T, H, T + 100 * H)).toBeNull();
  });

  it('the -v2 literals are a separate family: BARRIER_SPECS stays exactly the three -v1 specs', () => {
    expect(BARRIER_SPECS.map((s) => s.spec)).toEqual(['tau1.0-floor0.30-v1', 'tau0.5-floor0.30-v1', 'tau2.0-floor0.30-v1']);
    expect(BARRIER_SPECS_V2.map((s) => s.spec)).toEqual(['tau1.0-floor0.30-v2', 'tau0.5-floor0.30-v2', 'tau2.0-floor0.30-v2']);
    expect(BARRIER_SPECS_V2.map((s) => s.tau)).toEqual(BARRIER_SPECS.map((s) => s.tau));
  });
});

describe('ONE served-step lookup (tf-support.ts) — behaviour-identical to the table it replaced', () => {
  const ADAPTERS: Record<string, (tf: string) => number | null> = {
    HL: S_HL, BINANCE: S_BINANCE, BYBIT: S_BYBIT, OKX: S_OKX, BITGET: S_BITGET, ASTER: S_ASTER, EDGEX: S_EDGEX,
    GATE: S_GATE, MEXC: S_MEXC, KUCOIN: S_KUCOIN, PHEMEX: S_PHEMEX, BINGX: S_BINGX, HTX: S_HTX, WEEX: S_WEEX,
    BITMART: S_BITMART, XT: S_XT, WHITEBIT: S_WHITEBIT,
  };
  it('for every venue × timeframe: the adapter\'s own served interval, else the requested one', () => {
    let substituted = 0;
    for (const [venue, fn] of Object.entries(ADAPTERS)) {
      for (const tf of Object.keys(TF_MS)) {
        const want = fn(tf) ?? TF_MS[tf];
        expect(servedCandleStepMs(venue, tf), `${venue} ${tf}`).toBe(want);
        expect(servedStepMs(venue, tf), `${venue} ${tf}`).toBe(want);
        if (want !== TF_MS[tf]) substituted++;
      }
    }
    expect(substituted).toBe(30); // fetch-and-relabel pairs today (a count test pins the table, not a doc)
    expect(servedStepMs('NOT_A_VENUE', '1h')).toBe(H);
  });
});
