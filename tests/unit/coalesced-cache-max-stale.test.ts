// OPS-PERFSTATS-SWR-W1 — maxStaleMs: the oldest a STALE value may be and still be served.
// Without it, a stale-serving cache can hand out an arbitrarily old value for as long as its loads keep
// failing — a silent stale. With it, past the bound the value is treated as absent: a timed-out read awaits
// the load and a failed load rethrows (or serves `fallback`), so a broken refresh surfaces (fail toward noise).
// undefined keeps every existing consumer byte-identical. Fake timers drive both the race and Date.now().
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { coalescedCache } from '../../src/lib/coalesced-cache.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function deferredLoad() {
  const deferreds: Array<{ res: (v: string) => void; rej: (e: Error) => void }> = [];
  const load = vi.fn(() => new Promise<string>((res, rej) => { deferreds.push({ res, rej }); }));
  return { load, deferreds };
}

async function seed(c: ReturnType<typeof coalescedCache<string>>, deferreds: ReturnType<typeof deferredLoad>['deferreds'], v: string) {
  const p = c.get('k');
  deferreds[deferreds.length - 1].res(v);
  await vi.advanceTimersByTimeAsync(0);
  expect(await p).toBe(v);
}

function settled<T>(p: Promise<T>): { done: () => boolean } {
  let d = false;
  void p.then(() => { d = true; }, () => { d = true; });
  return { done: () => d };
}

describe('coalescedCache maxStaleMs', () => {
  it('stale YOUNGER than maxStaleMs → served at the load timeout (load keeps running, single-flight)', async () => {
    const { load, deferreds } = deferredLoad();
    const c = coalescedCache<string>({ load, ttlMs: 1_000, staleOk: true, loadTimeoutMs: 500, maxStaleMs: 10_000 });
    await seed(c, deferreds, 'OLD');
    await vi.advanceTimersByTimeAsync(5_000);          // age 5 s: past ttl, inside maxStale
    const p = c.get('k');
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe('OLD');
    expect(load).toHaveBeenCalledTimes(2);              // the refresh is in flight
    deferreds[1].res('NEW');
    await vi.advanceTimersByTimeAsync(0);
    expect(await c.get('k')).toBe('NEW');               // self-warmed
  });

  it('stale OLDER than maxStaleMs → NOT served on timeout; the read awaits the load', async () => {
    const { load, deferreds } = deferredLoad();
    const c = coalescedCache<string>({ load, ttlMs: 1_000, staleOk: true, loadTimeoutMs: 500, maxStaleMs: 10_000 });
    await seed(c, deferreds, 'OLD');
    await vi.advanceTimersByTimeAsync(10_001);         // age past maxStale
    const p = c.get('k');
    const s = settled(p);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.done()).toBe(false);                       // still awaiting — never handed the too-old value
    deferreds[1].res('NEW');
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toBe('NEW');
  });

  it('load THROWS with stale inside maxStaleMs → stale served (stale-if-error)', async () => {
    const { load, deferreds } = deferredLoad();
    const c = coalescedCache<string>({ load, ttlMs: 1_000, staleOk: true, maxStaleMs: 10_000 });
    await seed(c, deferreds, 'OLD');
    await vi.advanceTimersByTimeAsync(5_000);
    const p = c.get('k');
    deferreds[1].rej(new Error('db down'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toBe('OLD');
  });

  it('load THROWS with stale past maxStaleMs and no fallback → the error surfaces', async () => {
    const { load, deferreds } = deferredLoad();
    const c = coalescedCache<string>({ load, ttlMs: 1_000, staleOk: true, maxStaleMs: 10_000 });
    await seed(c, deferreds, 'OLD');
    await vi.advanceTimersByTimeAsync(10_001);
    const p = c.get('k');
    const caught = p.catch((e: Error) => e.message);
    deferreds[1].rej(new Error('db down'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await caught).toBe('db down');
  });

  it('load THROWS with stale past maxStaleMs but a fallback exists → fallback, never the too-old value', async () => {
    const { load, deferreds } = deferredLoad();
    const c = coalescedCache<string>({ load, ttlMs: 1_000, staleOk: true, maxStaleMs: 10_000, fallback: () => 'FB' });
    await seed(c, deferreds, 'OLD');
    await vi.advanceTimersByTimeAsync(10_001);
    const p = c.get('k');
    deferreds[1].rej(new Error('db down'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toBe('FB');
  });

  it('negative memo past maxStaleMs → does not serve the too-old value; the load runs', async () => {
    const { load, deferreds } = deferredLoad();
    const c = coalescedCache<string>({ load, ttlMs: 1_000, staleOk: true, maxStaleMs: 10_000, negativeTtlMs: 60_000, random: () => 0.5 });
    await seed(c, deferreds, 'OLD');
    await vi.advanceTimersByTimeAsync(5_000);
    const p1 = c.get('k');                               // fails inside maxStale → stale + 60 s negative memo
    deferreds[1].rej(new Error('db down'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await p1).toBe('OLD');
    await vi.advanceTimersByTimeAsync(6_000);           // age 11 s (past maxStale), memo still active
    const p2 = c.get('k');
    expect(load).toHaveBeenCalledTimes(3);               // memo did NOT short-circuit to the too-old value
    deferreds[2].res('NEW');
    await vi.advanceTimersByTimeAsync(0);
    expect(await p2).toBe('NEW');
  });

  it('maxStaleMs undefined → an arbitrarily old stale is still served on timeout (byte-identical to pre-W1)', async () => {
    const { load, deferreds } = deferredLoad();
    const c = coalescedCache<string>({ load, ttlMs: 1_000, staleOk: true, loadTimeoutMs: 500 });
    await seed(c, deferreds, 'OLD');
    await vi.advanceTimersByTimeAsync(86_400_000);      // a day old
    const p = c.get('k');
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe('OLD');
  });
});
