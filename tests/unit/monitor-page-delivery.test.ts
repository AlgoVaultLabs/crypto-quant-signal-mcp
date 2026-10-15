/**
 * OPS-DIGEST-DELIVERY-DURABLE-W1 CH1 — a page is MARKED only when it was DELIVERED.
 *
 * Pre-wave `runCritical` did `await sendAlert(msg, level); markAlerted(state, key);`: the
 * boolean was discarded, so an undelivered page opened the 30-minute dedup window as if the
 * operator had read it. These tests EXECUTE `firePage` — the step `runCritical` now calls —
 * rather than grepping for it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { firePage, shouldAlert, markAlerted, DEDUP_WINDOW_MS, type AlertState } from '../../src/scripts/monitor-page.js';

const fresh = (): AlertState => ({ lastAlerted: {}, consecutiveFails: { exchanges: 3 } });

afterEach(() => vi.restoreAllMocks());

describe('firePage', () => {
  it('send → false ⇒ lastAlerted[key] UNSET, counter unchanged, PAGE_UNDELIVERED logged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const state = fresh();
    const delivered = await firePage({ state, key: 'exchanges', msg: 'Exchange API failures: OKX', level: 'warning', send: async () => false });
    expect(delivered).toBe(false);
    expect(state.lastAlerted.exchanges).toBeUndefined();
    expect(state.consecutiveFails.exchanges).toBe(3);
    expect(log.mock.calls.flat().join(' ')).toContain('[monitor] PAGE_UNDELIVERED exchanges — re-fires next cycle');
    // …so the very next cycle is still allowed to fire.
    expect(shouldAlert(state, 'exchanges')).toBe(true);
  });

  it('send → true ⇒ lastAlerted[key] set, and the dedup window now suppresses a re-fire', async () => {
    const state = fresh();
    const before = Date.now();
    const delivered = await firePage({ state, key: 'exchanges', msg: 'm', level: 'warning', send: async () => true });
    expect(delivered).toBe(true);
    expect(state.lastAlerted.exchanges).toBeGreaterThanOrEqual(before);
    expect(state.consecutiveFails.exchanges).toBe(3);
    expect(shouldAlert(state, 'exchanges')).toBe(false);
  });

  it('a sender that THROWS is undelivered, never a crashed tick', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const state = fresh();
    const delivered = await firePage({
      state, key: 'database', msg: 'm', level: 'critical',
      send: async () => { throw new Error('boom'); },
    });
    expect(delivered).toBe(false);
    expect(state.lastAlerted.database).toBeUndefined();
  });

  it('passes the message and level through to the sender untouched', async () => {
    const send = vi.fn(async () => true);
    await firePage({ state: fresh(), key: 'k', msg: 'the message', level: 'critical', send });
    expect(send).toHaveBeenCalledWith('the message', 'critical');
  });

  it('the moved helpers keep their semantics (30-minute window, value unchanged)', () => {
    expect(DEDUP_WINDOW_MS).toBe(30 * 60 * 1000);
    const state = fresh();
    markAlerted(state, 'k');
    expect(shouldAlert(state, 'k')).toBe(false);
    state.lastAlerted.k = Date.now() - DEDUP_WINDOW_MS - 1;
    expect(shouldAlert(state, 'k')).toBe(true);
  });
});

describe('runCritical routes its page through firePage', () => {
  it('monitor.ts no longer marks a page it did not deliver', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/scripts/monitor.ts', import.meta.url), 'utf8');
    // The pre-wave shape — the boolean discarded, then marked — must not come back.
    expect(src).not.toMatch(/await sendAlert\(msg, level\);\s*markAlerted\(/);
    expect(src).toMatch(/if \(await firePage\(\{ state, key, msg, level \}\)\)/);
  });
});
