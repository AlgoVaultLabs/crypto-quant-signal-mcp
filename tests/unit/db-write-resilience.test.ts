/**
 * OPS-SIGNAL-WRITE-RESILIENCE-W1 — make fire-and-forget PG writes resilient + loud.
 *
 * Root cause of the 2026-06-05 signal-write loss: `recordSignal -> run() ->
 * pool.query(...).catch(console.error)` was fire-and-forget with NO retry, so a
 * transient (musl/Alpine `getaddrinfo EAI_AGAIN postgres` under concurrent seed
 * load, a connection drop, a brief PG restart) silently, permanently lost the
 * INSERT. These two pure helpers underpin the fix: classify which errors are
 * worth retrying, and a generic bounded retry with injectable sleep.
 */
import { describe, it, expect } from 'vitest';
import { isTransientDbError, retryAsync } from '../../src/lib/performance-db.js';

describe('isTransientDbError', () => {
  it('treats DNS / connection / overload errors as transient (retryable)', () => {
    expect(isTransientDbError({ code: 'EAI_AGAIN' })).toBe(true);
    expect(isTransientDbError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTransientDbError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isTransientDbError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientDbError({ code: 'ENOTFOUND' })).toBe(true);
    expect(isTransientDbError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientDbError(new Error('getaddrinfo EAI_AGAIN postgres'))).toBe(true);
    expect(isTransientDbError(new Error('sorry, too many clients already'))).toBe(true);
  });

  it('does NOT retry deterministic query errors (would just fail again)', () => {
    expect(isTransientDbError(new Error('syntax error at or near "SELET"'))).toBe(false);
    expect(isTransientDbError({ code: '23505' })).toBe(false); // unique_violation
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
  });
});

describe('retryAsync', () => {
  const nosleep = () => Promise.resolve();

  it('returns ok on first success (1 attempt)', async () => {
    let calls = 0;
    const r = await retryAsync(async () => { calls++; return 'v'; }, { sleep: nosleep });
    expect(r).toEqual({ ok: true, value: 'v', attempts: 1 });
    expect(calls).toBe(1);
  });

  it('retries transient failures then succeeds, reporting the attempt count', async () => {
    let calls = 0;
    const r = await retryAsync(
      async () => { calls++; if (calls < 3) throw { code: 'EAI_AGAIN' }; return 'ok'; },
      { isRetryable: isTransientDbError, sleep: nosleep },
    );
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it('gives up after the attempt cap on a persistent transient failure', async () => {
    let calls = 0;
    const r = await retryAsync(
      async () => { calls++; throw { code: 'EAI_AGAIN' }; },
      { attempts: 4, isRetryable: isTransientDbError, sleep: nosleep },
    );
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(4);
    expect(calls).toBe(4);
  });

  it('does not retry a non-retryable error (fails fast on attempt 1)', async () => {
    let calls = 0;
    const r = await retryAsync(
      async () => { calls++; throw new Error('syntax error'); },
      { isRetryable: isTransientDbError, sleep: nosleep },
    );
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(1);
    expect(calls).toBe(1);
  });
});
