import { describe, it, expect } from 'vitest';
import { chatQuotaApiKey } from '../../src/lib/chat-rate-limit.js';

/**
 * OPS-AUDIT-REMEDIATION-HIGH-W1 · Ch1 · SEC-03 generator guard.
 *
 * The defect: `chatQuotaApiKey` ended `` `ip:${ipHash ?? 'unknown'}` ``, so every caller the
 * server could not identify was metered into ONE literal `ip:unknown` bucket — a single global
 * 10/month counter shared by the whole internet. `/api/chat` never entered the AsyncLocalStorage
 * store (only `/mcp` does), so on that route the null branch was the ONLY branch.
 *
 * The invariant these tests pin is deliberately stronger than "don't return 'ip:unknown'":
 * **no quota key may ever be a constant.** A future refactor that swaps one sentinel for another
 * re-introduces the same shared-bucket bug, so the test asserts the property, not the literal.
 */
describe('chatQuotaApiKey — a quota key may never be a constant (SEC-03)', () => {
  it('buckets a licensed caller on their own key', () => {
    expect(chatQuotaApiKey('av_live_abc123', 'iphash1')).toBe('av_live_abc123');
    // The license wins over the IP — a paying caller is never metered as anonymous.
    expect(chatQuotaApiKey('av_live_abc123', null)).toBe('av_live_abc123');
  });

  it('buckets an anonymous caller on their own ipHash — two IPs are two buckets', () => {
    const a = chatQuotaApiKey(null, 'hash_aaa');
    const b = chatQuotaApiKey(null, 'hash_bbb');
    expect(a).toBe('ip:hash_aaa');
    expect(b).toBe('ip:hash_bbb');
    expect(a).not.toBe(b);
  });

  it('NEVER emits the shared `ip:unknown` sentinel when identity is missing', () => {
    // This is the exact regression. Pre-fix both calls returned the string 'ip:unknown'.
    for (const ipHash of [null, undefined as unknown as null, '']) {
      const key = chatQuotaApiKey(null, ipHash);
      expect(key).not.toBe('ip:unknown');
      expect(key).not.toContain('unknown');
    }
  });

  it('fails closed: an unidentifiable caller gets a UNIQUE key, never a shared one', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 50; i++) keys.add(chatQuotaApiKey(null, null));
    // 50 unidentifiable requests must produce 50 distinct buckets. Pre-fix: exactly 1.
    expect(keys.size).toBe(50);
  });

  it('property: across every null/empty input combination, no two callers collide', () => {
    const emptyish: Array<string | null> = [null, '', undefined as unknown as null];
    const produced: string[] = [];
    for (const lk of emptyish) {
      for (const ip of emptyish) produced.push(chatQuotaApiKey(lk, ip));
    }
    // Every one of these is an unidentifiable caller, so every key must be distinct.
    expect(new Set(produced).size).toBe(produced.length);
  });
});
