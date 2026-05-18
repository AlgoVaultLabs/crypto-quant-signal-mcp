/**
 * AV-CHAT-MCP-W1 (C4) — vitest canary for src/lib/result-cache.ts.
 *
 * Locks the generic ResultCache<T> primitive's invariants:
 *   - TTL: entries expire after ttlMs (re-get returns undefined).
 *   - Max: capacity-eviction drops least-recently-used.
 *   - Clear: removes all entries.
 *   - Constructor rejects invalid ttlMs / max.
 */
import { describe, it, expect } from 'vitest';
import { ResultCache } from '../../src/lib/result-cache.js';

describe('ResultCache (AV-CHAT-MCP-W1 C1 primitive)', () => {
  it('respects TTL — entry expires after ttlMs (real timer, short interval)', async () => {
    // lru-cache@10 uses its own internal clock; vi.useFakeTimers does not
    // affect it. Use a short real-timer interval to validate TTL semantics.
    const cache = new ResultCache<string>({ ttlMs: 30, max: 10 });
    cache.set('k1', 'v1');
    expect(cache.get('k1')).toBe('v1');
    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get('k1')).toBeUndefined();
  });

  it('respects max — LRU evicts oldest entries', () => {
    const cache = new ResultCache<number>({ ttlMs: 60_000, max: 3 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.size()).toBe(3);
    cache.set('d', 4);
    expect(cache.size()).toBe(3);
    expect(cache.get('a')).toBeUndefined(); // 'a' was LRU
    expect(cache.get('d')).toBe(4);
  });

  it('clear() empties the cache', () => {
    const cache = new ResultCache<string>({ ttlMs: 60_000, max: 10 });
    cache.set('k1', 'v1');
    cache.set('k2', 'v2');
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get('k1')).toBeUndefined();
  });

  it('constructor rejects invalid ttlMs and max', () => {
    expect(() => new ResultCache({ ttlMs: 0, max: 10 })).toThrow(/ttlMs/);
    expect(() => new ResultCache({ ttlMs: -1, max: 10 })).toThrow(/ttlMs/);
    expect(() => new ResultCache({ ttlMs: 1000, max: 0 })).toThrow(/max/);
    expect(() => new ResultCache({ ttlMs: 1000, max: 1.5 })).toThrow(/max/);
  });
});
