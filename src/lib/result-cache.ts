/**
 * Generic TTL+LRU result cache — AV-CHAT-MCP-W1 (C1).
 *
 * Wraps `lru-cache@^10`. Used by:
 *   - SearchEngine  → ResultCache<SearchResult[]>  (ttl 1h,  max 500)
 *   - ChatEngine    → ResultCache<ChatResult>      (ttl 24h, max 200)
 *
 * Both consumers instantiate their own. The primitive is pure: no side effects
 * beyond cache state, no globals, no I/O. Safe under Node's single-threaded
 * event loop for atomic swaps inside the rebuild path.
 */
import { LRUCache } from 'lru-cache';

export interface ResultCacheOpts {
  ttlMs: number;
  max: number;
}

export class ResultCache<T extends NonNullable<unknown>> {
  private readonly cache: LRUCache<string, T>;

  constructor(opts: ResultCacheOpts) {
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
      throw new Error(`ResultCache: ttlMs must be a positive number, got ${opts.ttlMs}`);
    }
    if (!Number.isInteger(opts.max) || opts.max <= 0) {
      throw new Error(`ResultCache: max must be a positive integer, got ${opts.max}`);
    }
    this.cache = new LRUCache<string, T>({
      max: opts.max,
      ttl: opts.ttlMs,
    });
  }

  get(key: string): T | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: T): void {
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}
