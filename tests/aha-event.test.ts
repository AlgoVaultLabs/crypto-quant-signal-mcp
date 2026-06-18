/**
 * CONVERSION-MEASUREMENT-W1 C1 — unit tests for the activation "aha" event
 * (`first_non_hold_verdict`). Pure: an injected recorder spy + module-state
 * reset between tests; no DB, no network. Covers the gating matrix (verdict /
 * tier / session), per-session dedup, and the fail-open contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  recordFirstNonHoldVerdict,
  shouldEmitFirstNonHold,
  _resetFirstNonHoldForTest,
} from '../src/lib/aha-event.js';

afterEach(() => {
  _resetFirstNonHoldForTest();
  vi.restoreAllMocks();
});

describe('aha-event — recordFirstNonHoldVerdict gating', () => {
  it('emits for a free session BUY (first time) with exact payload', () => {
    const rec = vi.fn();
    recordFirstNonHoldVerdict(
      { verdict: 'BUY', tier: 'free', sessionId: 's1', tool: 'get_trade_call', asset: 'BTC' },
      rec,
    );
    expect(rec).toHaveBeenCalledTimes(1);
    expect(rec).toHaveBeenCalledWith({
      eventType: 'first_non_hold_verdict',
      sessionId: 's1',
      licenseTier: 'free',
      meta: { verdict: 'BUY', tool: 'get_trade_call', asset: 'BTC' },
    });
  });

  it('normalises verdict case (sell → SELL) and defaults asset to null', () => {
    const rec = vi.fn();
    recordFirstNonHoldVerdict({ verdict: 'sell', tier: 'free', sessionId: 's2', tool: 'get_trade_signal' }, rec);
    expect(rec).toHaveBeenCalledTimes(1);
    const payload = rec.mock.calls[0][0];
    expect(payload.meta).toEqual({ verdict: 'SELL', tool: 'get_trade_signal', asset: null });
  });

  it('does NOT emit for HOLD', () => {
    const rec = vi.fn();
    recordFirstNonHoldVerdict({ verdict: 'HOLD', tier: 'free', sessionId: 's3', tool: 'get_trade_call' }, rec);
    expect(rec).not.toHaveBeenCalled();
  });

  it('does NOT emit for undefined / null / empty verdict', () => {
    const rec = vi.fn();
    recordFirstNonHoldVerdict({ verdict: undefined, tier: 'free', sessionId: 's4', tool: 'get_trade_call' }, rec);
    recordFirstNonHoldVerdict({ verdict: null, tier: 'free', sessionId: 's5', tool: 'get_trade_call' }, rec);
    recordFirstNonHoldVerdict({ verdict: '', tier: 'free', sessionId: 's6', tool: 'get_trade_call' }, rec);
    expect(rec).not.toHaveBeenCalled();
  });

  it('does NOT emit for non-free tiers (starter/pro/enterprise/internal/x402)', () => {
    const rec = vi.fn();
    for (const tier of ['starter', 'pro', 'enterprise', 'internal', 'x402']) {
      recordFirstNonHoldVerdict({ verdict: 'BUY', tier, sessionId: `s-${tier}`, tool: 'get_trade_call' }, rec);
    }
    expect(rec).not.toHaveBeenCalled();
  });

  it('does NOT emit when sessionId is missing (null / undefined / empty)', () => {
    const rec = vi.fn();
    recordFirstNonHoldVerdict({ verdict: 'BUY', tier: 'free', sessionId: null, tool: 'get_trade_call' }, rec);
    recordFirstNonHoldVerdict({ verdict: 'BUY', tier: 'free', sessionId: undefined, tool: 'get_trade_call' }, rec);
    recordFirstNonHoldVerdict({ verdict: 'BUY', tier: 'free', sessionId: '', tool: 'get_trade_call' }, rec);
    expect(rec).not.toHaveBeenCalled();
  });
});

describe('aha-event — per-session dedup + fail-open', () => {
  it('dedups per session — a second non-HOLD for the same session does NOT emit', () => {
    const rec = vi.fn();
    recordFirstNonHoldVerdict({ verdict: 'BUY', tier: 'free', sessionId: 'dup', tool: 'get_trade_call' }, rec);
    recordFirstNonHoldVerdict({ verdict: 'SELL', tier: 'free', sessionId: 'dup', tool: 'get_trade_signal' }, rec);
    expect(rec).toHaveBeenCalledTimes(1);
  });

  it('distinct sessions each emit once', () => {
    const rec = vi.fn();
    recordFirstNonHoldVerdict({ verdict: 'BUY', tier: 'free', sessionId: 'a', tool: 'get_trade_call' }, rec);
    recordFirstNonHoldVerdict({ verdict: 'BUY', tier: 'free', sessionId: 'b', tool: 'get_trade_call' }, rec);
    expect(rec).toHaveBeenCalledTimes(2);
  });

  it('fail-open — a throwing recorder never propagates', () => {
    const rec = vi.fn(() => {
      throw new Error('db down');
    });
    expect(() =>
      recordFirstNonHoldVerdict({ verdict: 'BUY', tier: 'free', sessionId: 'z', tool: 'get_trade_call' }, rec),
    ).not.toThrow();
  });
});

describe('aha-event — shouldEmitFirstNonHold', () => {
  it('returns true once per session, false thereafter', () => {
    expect(shouldEmitFirstNonHold('x')).toBe(true);
    expect(shouldEmitFirstNonHold('x')).toBe(false);
    expect(shouldEmitFirstNonHold('y')).toBe(true);
  });
});
