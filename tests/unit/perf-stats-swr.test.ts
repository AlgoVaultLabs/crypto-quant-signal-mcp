// OPS-PERFSTATS-SWR-W1 — the perf-stats snapshot is computed OFF the request path.
//
// 2026-11-20 02:00:04Z: the editorial livedata fetch read /api/performance-public with a 15 s budget; the
// server's last compute had finished at 01:57:41 (60 s TTL → cold), so the read joined a compute that took
// 17,107 ms and was aborted at 15 s. Every reader arriving > TTL after the last compute waited for the whole
// O(table) compute. These tests drive getPerformanceStatsAsync() through its compute seam with fake timers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  getPerformanceStatsAsync,
  startPerfStatsWarmer,
  PERF_STATS_TTL_MS,
  PERF_STATS_MAX_STALE_MS,
  PERF_STATS_WARM_MS,
  PERF_STATS_STALE_WAIT_MS,
  _clearPerformanceStatsCache,
  _setPerformanceStatsComputeForTest,
  _stopPerfStatsWarmerForTest,
} from '../../src/lib/performance-db.js';
import type { PerformanceStats } from '../../src/lib/performance-db.js';

// A compute whose Nth call settles when the test says so.
function deferredCompute() {
  const calls: Array<{ res: (v: PerformanceStats) => void; rej: (e: Error) => void }> = [];
  const fn = vi.fn(() => new Promise<PerformanceStats>((res, rej) => { calls.push({ res, rej }); }));
  return { fn, calls };
}
const snap = (n: number) => ({ totalCalls: n } as unknown as PerformanceStats);

function settled<T>(p: Promise<T>): { done: () => boolean } {
  let d = false;
  void p.then(() => { d = true; }, () => { d = true; });
  return { done: () => d };
}

beforeEach(() => {
  vi.useFakeTimers();
  _clearPerformanceStatsCache();
});
afterEach(() => {
  _stopPerfStatsWarmerForTest();
  _setPerformanceStatsComputeForTest(null);
  _clearPerformanceStatsCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function seedSnapshot(c: ReturnType<typeof deferredCompute>, n: number) {
  const p = getPerformanceStatsAsync();
  c.calls[c.calls.length - 1].res(snap(n));
  await vi.advanceTimersByTimeAsync(0);
  expect((await p).totalCalls).toBe(n);
}

describe('perf-stats snapshot off the request path (OPS-PERFSTATS-SWR-W1)', () => {
  it('invariants: TTL < warm interval, and one missed warm tick still leaves a servable snapshot', () => {
    expect(PERF_STATS_TTL_MS).toBeLessThan(PERF_STATS_WARM_MS);
    expect(PERF_STATS_WARM_MS * 2).toBeLessThan(PERF_STATS_MAX_STALE_MS);
    expect(PERF_STATS_STALE_WAIT_MS).toBeLessThanOrEqual(1_000);
  });

  it('cold process: the first reader awaits the compute (there is nothing to serve yet)', async () => {
    const c = deferredCompute();
    _setPerformanceStatsComputeForTest(c.fn);
    const p = getPerformanceStatsAsync();
    const s = settled(p);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.done()).toBe(false);
    c.calls[0].res(snap(1));
    await vi.advanceTimersByTimeAsync(0);
    expect((await p).totalCalls).toBe(1);
  });

  it('past TTL: the reader gets the previous snapshot within the stale wait while ONE refresh runs', async () => {
    const c = deferredCompute();
    _setPerformanceStatsComputeForTest(c.fn);
    await seedSnapshot(c, 1);
    await vi.advanceTimersByTimeAsync(PERF_STATS_TTL_MS + 1);
    const p = getPerformanceStatsAsync();
    await vi.advanceTimersByTimeAsync(PERF_STATS_STALE_WAIT_MS);
    expect((await p).totalCalls).toBe(1);
    expect(c.fn).toHaveBeenCalledTimes(2);
    c.calls[1].res(snap(2));
    await vi.advanceTimersByTimeAsync(0);
    expect((await getPerformanceStatsAsync()).totalCalls).toBe(2);
    expect(c.fn).toHaveBeenCalledTimes(2);
  });

  it('replays 2026-11-20 02:00:04Z: a 17,107 ms compute no longer exceeds a 15 s reader', async () => {
    const c = deferredCompute();
    _setPerformanceStatsComputeForTest(c.fn);
    await seedSnapshot(c, 1_437_908);                    // 01:57:41 compute
    await vi.advanceTimersByTimeAsync(143_000);          // 02:00:04 — 2 m 23 s later, cache past TTL
    const reader = getPerformanceStatsAsync();
    const budget = new Promise<'TIMEOUT'>((res) => setTimeout(() => res('TIMEOUT'), 15_000));
    const raced = Promise.race([reader.then((s) => s.totalCalls), budget]);
    setTimeout(() => c.calls[1].res(snap(1_437_958)), 17_107);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await raced).toBe(1_437_908);                 // served, not 'TIMEOUT'
    await vi.advanceTimersByTimeAsync(2_107);
    expect((await getPerformanceStatsAsync()).totalCalls).toBe(1_437_958);
  });

  it('past MAX_STALE: never served — the reader awaits the refresh', async () => {
    const c = deferredCompute();
    _setPerformanceStatsComputeForTest(c.fn);
    await seedSnapshot(c, 1);
    await vi.advanceTimersByTimeAsync(PERF_STATS_MAX_STALE_MS + 1);
    const p = getPerformanceStatsAsync();
    const s = settled(p);
    await vi.advanceTimersByTimeAsync(PERF_STATS_STALE_WAIT_MS * 5);
    expect(s.done()).toBe(false);
    c.calls[1].res(snap(2));
    await vi.advanceTimersByTimeAsync(0);
    expect((await p).totalCalls).toBe(2);
  });

  it('a failing refresh: inside MAX_STALE the snapshot is served and the failure is logged; past it the error surfaces', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = deferredCompute();
    _setPerformanceStatsComputeForTest(c.fn);
    await seedSnapshot(c, 1);
    await vi.advanceTimersByTimeAsync(PERF_STATS_TTL_MS + 1);
    const p1 = getPerformanceStatsAsync();
    c.calls[1].rej(new Error('db down'));
    await vi.advanceTimersByTimeAsync(0);
    expect((await p1).totalCalls).toBe(1);
    expect(errSpy.mock.calls.some((a) => String(a[0]).includes('[perf-stats] refresh failed'))).toBe(true);

    await vi.advanceTimersByTimeAsync(PERF_STATS_MAX_STALE_MS);
    const p2 = getPerformanceStatsAsync();
    const caught = p2.catch((e: Error) => e.message);
    c.calls[2].rej(new Error('db down'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await caught).toBe('db down');
  });

  it('concurrent readers during a refresh share ONE compute', async () => {
    const c = deferredCompute();
    _setPerformanceStatsComputeForTest(c.fn);
    await seedSnapshot(c, 1);
    await vi.advanceTimersByTimeAsync(PERF_STATS_TTL_MS + 1);
    const ps = [1, 2, 3, 4, 5].map(() => getPerformanceStatsAsync());
    await vi.advanceTimersByTimeAsync(PERF_STATS_STALE_WAIT_MS);
    for (const p of ps) expect((await p).totalCalls).toBe(1);
    expect(c.fn).toHaveBeenCalledTimes(2);
  });

  it('startPerfStatsWarmer: computes at boot, refreshes every PERF_STATS_WARM_MS, idempotent', async () => {
    const c = deferredCompute();
    _setPerformanceStatsComputeForTest(c.fn);
    startPerfStatsWarmer();
    startPerfStatsWarmer();                              // second start is a no-op
    expect(c.fn).toHaveBeenCalledTimes(1);               // boot warm
    c.calls[0].res(snap(1));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PERF_STATS_WARM_MS);
    expect(c.fn).toHaveBeenCalledTimes(2);               // the snapshot was past TTL → one refresh
    c.calls[1].res(snap(2));
    await vi.advanceTimersByTimeAsync(0);
    expect((await getPerformanceStatsAsync()).totalCalls).toBe(2);
  });

  it('the long-lived server starts the warmer (src/index.ts listen callback)', () => {
    const src = readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf8');
    const start = src.indexOf('const httpServer = app.listen(');
    const listen = src.slice(start, src.indexOf('const shutdown = () =>', start));
    expect(start).toBeGreaterThan(-1);
    expect(listen).toMatch(/\bstartPerfStatsWarmer\(\)/);
    expect(src).toMatch(/import \{[^}]*\bstartPerfStatsWarmer\b[^}]*\} from '\.\/lib\/performance-db\.js'/);
  });
});
