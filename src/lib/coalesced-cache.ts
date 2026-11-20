/**
 * coalesced-cache.ts — OPS-HL-CACHE-STAMPEDE-GENERATOR-W1 (C1, the generator)
 *
 * ONE venue-agnostic cache primitive that retires the cache-stampede + process-
 * boundary bug classes for every HL-touching module cache (meta, getTopAssetsByOI,
 * getTop20ByOI) and any future venue cache. Combines four production-canonical
 * patterns + the codebase's process gate:
 *   - single-flight / request coalescing — N concurrent cold-fills for a key JOIN
 *     ONE upstream load (golang.org/x/sync/singleflight; proven locally in the
 *     hyperliquid `metaInflight` map this generalizes)
 *   - negative caching of failures — a throttled/failed load is memoized for a
 *     short jittered TTL so the resource is NOT re-hit every call (RFC 2308 /
 *     RFC 9520) — the direct stampede breaker
 *   - stale-while-revalidate — serve a stale value immediately on load failure
 *     instead of blocking/storming (RFC 5861)
 *   - jittered backoff — randomize the negative-TTL re-probe so lockstep callers
 *     (the 42 grid scorers) don't re-storm in sync (AWS / Marc Brooker)
 *   - process-boundary gate (caller-provided) — short-lived crons serve cache/
 *     fallback, never cold-fill a throttled resource (the isShortLivedScript
 *     predicate the consumer passes — kept OUT of this module so it stays
 *     dependency-free and can never be in an import cycle)
 *
 * FAIL-OPEN: a loader/cache defect is never worse than today's "throw → fallback".
 * Keys are strings (consumers key by dex / a fixed key).
 */

export interface CoalescedCacheOptions<V> {
  /** Upstream load for a key. Called at most once concurrently per key (single-flight). */
  load: (key: string) => Promise<V>;
  /** Success TTL (ms): a value fresher than this is served without a load. */
  ttlMs: number;
  /** Negative-memo TTL (ms) on a load FAILURE — suppresses re-load for this long.
   *  0 / undefined → no negative caching (a failure re-attempts on the next call;
   *  this is the byte-equivalent config for the meta single-flight cache). */
  negativeTtlMs?: number;
  /** Serve a stale cached value on load failure (RFC 5861 stale-if-error). */
  staleOk?: boolean;
  /** Last-resort value on load failure when no stale value exists. Returned AND
   *  negative-memoized. Absent → a failure with no stale value rethrows (fail-open). */
  fallback?: (key: string) => V;
  /** True (e.g. a short-lived cron) → serve cache-or-fallback and SKIP the loader.
   *  Default: never gated. Consumer passes `() => isShortLivedScript(process.argv[1])`. */
  processGate?: () => boolean;
  /** OPS-COALESCED-CACHE-LOAD-TIMEOUT-W1: bound a COLD load (ms). When set AND a fresh value
   *  is absent but stale-or-`fallback` can be served, race `load()` against this timeout; on
   *  timeout serve stale/fallback IMMEDIATELY and leave the in-flight `load()` running
   *  (single-flight) to self-warm `store` for the next caller. undefined (default) → await the
   *  load UNBOUNDED (byte-identical to pre-W1). Needed because `fallback` fires only on a load
   *  THROW — a slow NON-throwing load (e.g. an HL batch-yield WAIT ~58s) would otherwise block
   *  every caller for the full load. */
  loadTimeoutMs?: number;
  /** OPS-PERFSTATS-SWR-W1: the oldest a STALE value may be (ms since its real success) and still be served —
   *  by the load-timeout race, stale-if-error, the negative memo and the process gate. Older than this it is
   *  treated as absent: a timed-out read awaits the load, a failed load serves `fallback` or rethrows. So a
   *  refresh that keeps failing surfaces once the value ages out instead of serving it forever. undefined
   *  (default) → unbounded, byte-identical to pre-W1 for every existing consumer. */
  maxStaleMs?: number;
  /** ± jitter fraction on the negative TTL (default 0.2 = ±20%). */
  jitterPct?: number;
  /** Injectable clock (test seam). */
  now?: () => number;
  /** Injectable RNG in [0,1) (test seam). */
  random?: () => number;
}

interface Entry<V> {
  value?: V;             // last good (or fallback) value
  ts: number;            // when `value` was a real success (0 = fallback / never)
  negativeUntil: number; // suppress loads until this time (negative memo)
}

export interface CoalescedCache<V> {
  get(key: string): Promise<V>;
  _clear(key?: string): void;
  _getState(key: string): { value?: V; ts: number; negativeUntil: number; inflight: boolean } | null;
}

export function coalescedCache<V>(opts: CoalescedCacheOptions<V>): CoalescedCache<V> {
  const { load, ttlMs, fallback } = opts;
  const loadTimeoutMs = opts.loadTimeoutMs;
  const maxStaleMs = opts.maxStaleMs;
  const negativeTtlMs = opts.negativeTtlMs ?? 0;
  const staleOk = opts.staleOk ?? false;
  const gate = opts.processGate ?? (() => false);
  const jitterPct = opts.jitterPct ?? 0.2;
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? (() => Math.random());

  const store = new Map<string, Entry<V>>();
  const inflight = new Map<string, Promise<V>>();

  function negWindow(): number {
    if (negativeTtlMs <= 0) return 0;
    // ± jitterPct full jitter so lockstep callers de-correlate their re-probe.
    const factor = 1 + (random() * 2 - 1) * jitterPct;
    return Math.max(1, Math.round(negativeTtlMs * factor));
  }

  /** A cached value still young enough to serve. Fallback entries (ts=0) carry no real success, so under a
   *  maxStaleMs bound they never qualify — `serve` then re-derives the fallback itself. */
  function withinMaxStale(e: Entry<V>): boolean {
    return maxStaleMs === undefined || (e.ts > 0 && now() - e.ts < maxStaleMs);
  }

  function serve(key: string, e: Entry<V> | undefined): { hit: true; value: V } | { hit: false } {
    if (e && e.value !== undefined && withinMaxStale(e)) return { hit: true, value: e.value };
    if (fallback) return { hit: true, value: fallback(key) };
    return { hit: false };
  }

  async function get(key: string): Promise<V> {
    const t = now();
    const e = store.get(key);

    // (1) fresh hit (a real success within ttl; fallback entries carry ts=0 → never fresh)
    if (e && e.value !== undefined && e.ts > 0 && t - e.ts < ttlMs) return e.value;

    // (2) process-boundary gate: short-lived proc → never load; serve cache/fallback
    if (gate()) {
      const s = serve(key, e);
      if (s.hit) return s.value;
      // no cache + no fallback in a short-lived proc → fall through to load (can't serve nothing)
    }

    // (3) negative memo active → serve stale/fallback, suppress the load
    if (e && e.negativeUntil > t) {
      const s = serve(key, e);
      if (s.hit) return s.value;
    }

    // (4)+(5) single-flight: JOIN an in-flight load for this key, or start exactly ONE.
    let p = inflight.get(key);
    if (!p) {
      p = (async () => {
        try {
          const value = await load(key);
          store.set(key, { value, ts: now(), negativeUntil: 0 });
          return value;
        } catch (err) {
          const cur = store.get(key);
          const negativeUntil = now() + negWindow();
          if (staleOk && cur && cur.value !== undefined && withinMaxStale(cur)) {
            store.set(key, { value: cur.value, ts: cur.ts, negativeUntil });
            return cur.value;
          }
          if (fallback) {
            const fb = fallback(key);
            store.set(key, { value: fb, ts: 0, negativeUntil });
            return fb;
          }
          throw err; // fail-open: nothing to serve → never worse than today
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
    }

    // (6) OPS-COALESCED-CACHE-LOAD-TIMEOUT-W1 — bound the flight await (whether we JOINED an
    // existing load at (4) or STARTED one at (5)) so a slow NON-throwing load can't block a
    // hot read. A WAIT (e.g. HL batch-yield ~58s) is not a throw, so the catch/fallback alone
    // can't help. When loadTimeoutMs is set AND stale-or-fallback can be served, race `p`
    // against the timeout; on timeout serve stale/fallback NOW and leave `p` running
    // (single-flight) so its success branch self-warms `store` for the next caller. The
    // timeout sets NO negative memo (the load has not failed) and does NOT abort `p`. No
    // fallback/stale → await `p` (can't serve nothing — today's behavior). undefined
    // loadTimeoutMs → await `p` unbounded (byte-identical to pre-W1 for every other consumer).
    if (loadTimeoutMs !== undefined && loadTimeoutMs > 0) {
      const cur = store.get(key);
      const hasStale = staleOk && cur !== undefined && cur.value !== undefined && withinMaxStale(cur);
      if (hasStale || fallback) {
        const timedOut = Symbol('coalesced-load-timeout');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<typeof timedOut>((res) => {
          timer = setTimeout(() => res(timedOut), loadTimeoutMs);
        });
        const winner = await Promise.race([p, timeout]);
        if (timer) clearTimeout(timer);
        if (winner !== timedOut) return winner as V;          // load resolved first (real value or its own fallback)
        return hasStale ? (cur!.value as V) : fallback!(key); // timeout → serve now; `p` self-warms in the background
      }
    }
    return p;
  }

  return {
    get,
    _clear(key?: string) {
      if (key === undefined) { store.clear(); inflight.clear(); }
      else { store.delete(key); inflight.delete(key); }
    },
    _getState(key: string) {
      const e = store.get(key);
      if (!e) return null;
      return { value: e.value, ts: e.ts, negativeUntil: e.negativeUntil, inflight: inflight.has(key) };
    },
  };
}
